import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { log, isLoggingEnabled } from "./logger.js";
import type { ProxyServer } from "./types.js";
import { NativeHandler } from "./handlers/native-handler.js";
import { OpenRouterHandler } from "./handlers/openrouter-handler.js";
import { GeminiNativeHandler } from "./handlers/gemini-native-handler.js";
import type { APIHandler } from "./types.js";

export async function createProxyServer(
  port: number,
  openrouterApiKey?: string,
  model?: string,
  monitorMode: boolean = false,
  anthropicApiKey?: string,
  geminiApiKey?: string, // New: Gemini API Key
  useGeminiNative: boolean = false, // New: Explicit flag to force Gemini native
  modelMap?: { opus?: string; sonnet?: string; haiku?: string; subagent?: string }
): Promise<ProxyServer> {

  log(`[Proxy] createProxyServer called with geminiApiKey: ${geminiApiKey ? "Set" : "Not Set"}`);

  // Define handlers for different roles
  const nativeHandler = new NativeHandler(anthropicApiKey);
  let geminiNativeHandler: GeminiNativeHandler | undefined;
  if (geminiApiKey) {
    geminiNativeHandler = new GeminiNativeHandler(geminiApiKey);
    log(`[Proxy] GeminiNativeHandler instantiated.`);
  }

  const handlers = new Map<string, APIHandler>(); // Map from Target Model ID -> Handler Instance

  // Helper to get or create handler for a target model
  const getOpenRouterHandler = (targetModel: string): APIHandler => {
      if (!handlers.has(targetModel)) {
          handlers.set(targetModel, new OpenRouterHandler(targetModel, openrouterApiKey, port));
      }
      return handlers.get(targetModel)!;
  };

  // Pre-initialize handlers for mapped models to ensure warm-up (context window fetch etc)
  if (model) getOpenRouterHandler(model);
  if (modelMap?.opus) getOpenRouterHandler(modelMap.opus);
  if (modelMap?.sonnet) getOpenRouterHandler(modelMap.sonnet);
  if (modelMap?.haiku) getOpenRouterHandler(modelMap.haiku);
  if (modelMap?.subagent) getOpenRouterHandler(modelMap.subagent);

  const getHandlerForRequest = (requestedModel: string): APIHandler => {
      // 1. Monitor Mode Override
      if (monitorMode) {
        log(`[Proxy] Handler selected: NativeHandler (Monitor Mode) for model: ${requestedModel}`);
        return nativeHandler;
      }

      // 2. Resolve target model based on mappings or defaults
      let target = model || requestedModel; // Start with global default or request

      const req = requestedModel.toLowerCase();
      if (modelMap) {
          if (req.includes("opus") && modelMap.opus) target = modelMap.opus;
          else if (req.includes("sonnet") && modelMap.sonnet) target = modelMap.sonnet;
          else if (req.includes("haiku") && modelMap.haiku) target = modelMap.haiku;
          // Note: We don't verify "subagent" string because we don't know what Claude sends for subagents
          // unless it's "claude-3-haiku" (which is covered above) or specific.
          // Assuming Haiku mapping covers subagent unless custom logic added.
      }

      // 3. Explicit Native Gemini Decision (if flag is set)
      if (useGeminiNative && geminiNativeHandler) {
        log(`[Proxy] Handler selected: GeminiNativeHandler (explicitly requested) for model: ${requestedModel}`);
        return geminiNativeHandler;
      }

      // 4. Native Anthropic or Native Gemini Decision (fallback based on model ID)
      const isGeminiModel = target.includes("gemini") || target.includes("google/");

      if (isGeminiModel && geminiNativeHandler) {
        log(`[Proxy] Handler selected: GeminiNativeHandler for model: ${requestedModel} (target: ${target})`);
        return geminiNativeHandler;
      }
      // Heuristic: OpenRouter models have "/", Native Anthropic ones don't.
      const isNativeAnthropic = !target.includes("/");

      if (isNativeAnthropic) {
          // If we mapped to a native string (unlikely) or passed through
          log(`[Proxy] Handler selected: NativeHandler for model: ${requestedModel} (target: ${target})`);
          return nativeHandler;
      }

      // 4. OpenRouter Handler
      log(`[Proxy] Handler selected: OpenRouterHandler for model: ${requestedModel} (target: ${target})`);
      return getOpenRouterHandler(target);
  };


  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => c.json({ status: "ok", message: "Claudish Proxy", config: { mode: monitorMode ? "monitor" : "hybrid", mappings: modelMap } }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Token counting
  app.post("/v1/messages/count_tokens", async (c) => {
      try {
          const body = await c.req.json();
          const reqModel = body.model || "claude-3-opus-20240229";
          const handler = getHandlerForRequest(reqModel);

          // If native, we just forward. OpenRouter needs estimation.
          if (handler instanceof NativeHandler) {
              const headers: any = { "Content-Type": "application/json" };
              if (anthropicApiKey) headers["x-api-key"] = anthropicApiKey;

              const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", headers, body: JSON.stringify(body) });
              return c.json(await res.json());
          } else {
              // OpenRouter handler logic (estimation)
              const txt = JSON.stringify(body);
              return c.json({ input_tokens: Math.ceil(txt.length / 4) });
          }
      } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  app.post("/v1/messages", async (c) => {
      let currentToolUseIndex = 0;
      try {
          const body = await c.req.json();
          const handler = getHandlerForRequest(body.model);

          const messages: Message[] = [];
          let systemMessageContent: string | undefined;

          // Prioritize system message from body.system if present
          if (body.system) {
            systemMessageContent = body.system;
          }

          if (body.messages) {
            for (const msg of body.messages) {
              if (msg.role === "system") {
                // If system message is in body.messages and not already set by body.system, use it
                if (!systemMessageContent) {
                  systemMessageContent = typeof msg.content === "string" ? msg.content : (msg.content as any[]).map(block => block.text).join("\n");
                }
              } else if (msg.role === "user") {
                if (typeof msg.content === "string") {
                  messages.push({ role: "user", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                  messages.push({ role: "user", content: msg.content });
                }
              } else if (msg.role === "assistant") {
                if (typeof msg.content === "string") {
                  messages.push({ role: "assistant", content: msg.content });
                } else if (Array.isArray(msg.content)) {
                  messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
                }
              } else if (msg.role === "tool") {
                messages.push({ role: "tool", content: msg.content, tool_call_id: msg.tool_call_id });
              }
            }
          }

          // Add consolidated system message to the beginning of the messages array
          if (systemMessageContent) {
            messages.unshift({ role: "system", content: systemMessageContent });
          }


          const modelConfig: ModelConfig = {
            maxOutputTokens: body.max_tokens,
            temperature: body.temperature,
            topP: body.top_p,
            topK: body.top_k,
          };

          const tools = body.tools; // Assuming tools are directly available in the body

          let fullContent = "";
          let streamedContent = "";
          let isFirstTextChunk = true;
          let textBlockIndex = 0; // To track the index of the text content block for Anthropic format

          const stream = new ReadableStream({
              async start(controller) {
                  try {
                      const result = await handler.generate(
                          messages,
                          body.model,
                          (chunk: string) => {
                              fullContent += chunk;
                              if (isFirstTextChunk) {
                                controller.enqueue(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
                                controller.enqueue(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } })}\n\n`);
                                isFirstTextChunk = false;
                              }
                              controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: chunk } })}\n\n`);
                              streamedContent += chunk;
                          },
                          modelConfig,
                          tools,
                      );

                      // After generation completes, handle tool calls if any
                      if (result.toolCalls && result.toolCalls.length > 0) {
                          if (!isFirstTextChunk) { // If there was text content, close that block first
                              controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textBlockIndex })}\n\n`);
                          }
                          for (const tc of result.toolCalls) {
                              const toolUseBlockIndex = ++currentToolUseIndex; // Increment for each tool use
                              controller.enqueue(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: toolUseBlockIndex, content_block: { type: "tool_use", id: tc.id, name: tc.name, input: tc.args } })}\n\n`);
                              controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: toolUseBlockIndex })}\n\n`);
                          }
                      } else {
                          // If no tool calls, but there was text, ensure text block is stopped
                          if (!isFirstTextChunk) {
                              controller.enqueue(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: textBlockIndex })}\n\n`);
                          }
                      }


                      controller.enqueue(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: streamedContent.length > 0 ? Math.ceil(streamedContent.length / 4) : 1 } })}\n\n`); // Estimate output tokens
                      controller.enqueue(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                      controller.enqueue("data: [DONE]\n\n"); // Standard OpenAI/Anthropic stream termination

                      controller.close();
                  } catch (streamError) {
                      log(`[Proxy] Stream Error: ${streamError}`);
                      const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
                      controller.enqueue(`event: error\ndata: ${JSON.stringify({ type: "server_error", message: `Stream error: ${errorMessage}` })}\n\n`);
                      controller.close();
                  }
              },
          });

          return c.body(stream, {
              headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
              },
          });

      } catch (e) {
          log(`[Proxy] Error: ${e}`);
          return c.json({ error: { type: "server_error", message: String(e) } }, 500);
      }
  });

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

  // Port resolution
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr?.port ? addr.port : port;
  if (actualPort !== port) port = actualPort;

  log(`[Proxy] Server started on port ${port}`);

  return {
      port,
      url: `http://127.0.0.1:${port}`,
      shutdown: async () => {
          return new Promise<void>((resolve) => server.close((e) => resolve()));
      }
  };
}
