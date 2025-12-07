import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIHandler, GenerationResult, Message, ModelConfig, ToolCall } from "../types.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager, GeminiThoughtSignatureMiddleware } from "../middleware/index.js";
import { transformOpenAIToClaude, removeUriFormat } from "../transform.js";
import { log, logStructured, isLoggingEnabled } from "../logger.js";
import { fetchModelContextWindow, doesModelSupportReasoning } from "../model-loader.js";
import { generateUniqueId } from "../utils.js";
import { getConfig } from "../state.js";
import { OPENROUTER_API_URL, OLLAMA_DEFAULT_HOST, OPENROUTER_HEADERS } from "../config.js";

export class OpenRouterHandler implements APIHandler {
  private targetModel: string;
  private apiKey?: string;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private contextWindowCache = new Map<string, number>();
  private port: number;
  private sessionTotalCost = 0;
  private CLAUDE_INTERNAL_CONTEXT_MAX = 200000;

  constructor(targetModel: string, apiKey: string | undefined, port: number) {
    this.targetModel = targetModel;
    this.apiKey = apiKey;
    this.port = port;
    this.adapterManager = new AdapterManager(targetModel);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.register(new GeminiThoughtSignatureMiddleware());
    this.middlewareManager.initialize().catch(err => log(`[Handler:${targetModel}] Middleware init error: ${err}`));
    this.fetchContextWindow(targetModel);
  }

  private async fetchContextWindow(model: string) {
    if (this.contextWindowCache.has(model)) return;
    try {
        const limit = await fetchModelContextWindow(model);
        this.contextWindowCache.set(model, limit);
    } catch (e) {}
  }

  private getTokenScaleFactor(model: string): number {
      const limit = this.contextWindowCache.get(model) || 200000;
      return limit === 0 ? 1 : this.CLAUDE_INTERNAL_CONTEXT_MAX / limit;
  }

  private writeTokenFile(input: number, output: number) {
      try {
          const total = input + output;
          const limit = this.contextWindowCache.get(this.targetModel) || 200000;
          const leftPct = limit > 0 ? Math.max(0, Math.min(100, Math.round(((limit - total) / limit) * 100))) : 100;
          const data = {
              input_tokens: input,
              output_tokens: output,
              total_tokens: total,
              total_cost: this.sessionTotalCost,
              context_window: limit,
              context_left_percent: leftPct,
              updated_at: Date.now()
          };
          writeFileSync(join(tmpdir(), `claudish-tokens-${this.port}.json`), JSON.stringify(data), "utf-8");
      } catch (e) {}
  }

  async generate(
    messages: Message[],
    modelId: string,
    onChunk: (chunk: string) => void,
    modelConfig?: ModelConfig,
    tools?: any[], // New: Optional tools parameter
  ): Promise<GenerationResult> {
    const config = getConfig();
    const target = modelId;
    await this.fetchContextWindow(target);

    logStructured(`Request Handling`, { targetModel: target, originalModel: modelId, adapter: config.adapter });

    const request = {
      model: modelId,
      messages: messages,
      temperature: modelConfig?.temperature,
      max_tokens: modelConfig?.maxOutputTokens,
      top_p: modelConfig?.topP,
      top_k: modelConfig?.topK,
    };

    const convertedMessages = this.convertMessages(messages, target);
    const convertedTools = this.convertTools(tools);
    const supportsReasoning = await doesModelSupportReasoning(target);

    const openRouterPayload: any = {
      model: target,
      messages: convertedMessages,
      temperature: request.temperature ?? 1,
      stream: true,
      max_tokens: request.max_tokens,
      tools: convertedTools.length > 0 ? convertedTools : undefined,
      stream_options: { include_usage: true },
    };

    if (supportsReasoning && config.adapter !== 'ollama') openRouterPayload.include_reasoning = true;

    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === 'function') adapter.reset();
    adapter.prepareRequest(openRouterPayload, request);

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools: convertedTools, stream: true });

    let apiUrl = OPENROUTER_API_URL;
    let headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...OPENROUTER_HEADERS,
    };

    if (config.adapter === 'ollama') {
      const ollamaHost = config.ollamaHost || OLLAMA_DEFAULT_HOST;
      apiUrl = `${ollamaHost}/api/chat`;
      headers = { "Content-Type": "application/json" };
      log(`[OllamaAdapter] Using Ollama endpoint: ${apiUrl}`);
    }

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(openRouterPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`API Error: ${response.status} - ${errorText}`);
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    return this.handleStreamingResponse(response, adapter, target, onChunk);
  }


  // Remove the unused processUserMessage and processAssistantMessage
  private processUserMessage(msg: Message, messages: any[]) {}
  private processAssistantMessage(msg: any, messages: any[]) {}

  private convertTools(tools: any[] | undefined): any[] {
      return tools?.map((tool: any) => ({
          type: "function",
          function: {
              name: tool.name,
              description: tool.description,
              parameters: removeUriFormat(tool.input_schema),
          },
      })) || [];
  }

  private async handleStreamingResponse(response: Response, adapter: any, target: string, onChunk: (chunk: string) => void): Promise<GenerationResult> {
      const decoder = new TextDecoder();

      // Capture middleware manager for use in closure
      const middlewareManager = this.middlewareManager;
      // Shared metadata for middleware across all chunks in this stream
      const streamMetadata = new Map<string, any>();

      // State for accumulating results
      let fullContent = "";
      const toolCalls: ToolCall[] = [];
      const reasoningDetails: any[] = [];
      let currentToolCall: ToolCall | null = null;

      try {
          const reader = response.body!.getReader();
          let buffer = "";
          while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                  if (!line.trim() || !line.startsWith("data: ")) continue;
                  const dataStr = line.slice(6);
                  if (dataStr === "[DONE]") { break; }
                  try {
                      const chunk = JSON.parse(dataStr);
                      const delta = chunk.choices?.[0]?.delta;
                      if (delta) {
                          // Call middleware afterStreamChunk to extract reasoning_details
                          // The middleware is expected to populate streamMetadata with reasoning_details
                          await middlewareManager.afterStreamChunk({
                              modelId: target,
                              chunk,
                              delta,
                              metadata: streamMetadata,
                          });

                          const txt = delta.content || "";
                          if (txt) {
                              onChunk(txt);
                              fullContent += txt;
                          }

                          if (delta.tool_calls) {
                              for (const tc of delta.tool_calls) {
                                  // OpenRouter tool calls are similar to OpenAI format
                                  // id, type, function { name, arguments }
                                  if (tc.function?.name) {
                                      currentToolCall = {
                                          id: tc.id || `tool_${Date.now()}_${generateUniqueId()}`,
                                          name: tc.function.name,
                                          args: JSON.parse(tc.function.arguments || "{}"), // Arguments might come as partial JSON strings
                                      };
                                      toolCalls.push(currentToolCall);
                                  } else if (currentToolCall && tc.function?.arguments) {
                                      // Append to existing tool call arguments
                                      // This assumes arguments are streamed as partial JSON
                                      const existingArgs = JSON.stringify(currentToolCall.args);
                                      const newArgs = existingArgs.slice(0, -1) + tc.function.arguments + "}";
                                      currentToolCall.args = JSON.parse(newArgs);
                                  }
                              }
                          }
                      }
                  } catch (e) {
                      log(`Error parsing OpenRouter stream chunk: ${e}`);
                  }
              }
          }

          // After stream ends, extract any reasoning details collected by middleware
          const collectedReasoningDetails = streamMetadata.get('reasoning_details') || [];
          if (collectedReasoningDetails.length > 0) {
            reasoningDetails.push(...collectedReasoningDetails);
          }

      } catch (e) {
          log(`Error in OpenRouter streaming response: ${e}`);
          throw e;
      }

      // Finalize and return GenerationResult
      return {
          fullContent,
          toolCalls,
          reasoningDetails,
      };
  }
} // Missing closing brace added here
