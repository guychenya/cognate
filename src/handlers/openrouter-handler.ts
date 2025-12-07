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

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
  "X-Title": "Claudish - OpenRouter Proxy",
};

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
    const target = modelId;
    await this.fetchContextWindow(target);
    // const toolCalls: ToolCall[] = []; // toolCalls and reasoningDetails are now gathered in handleStreamingResponse
    // const reasoningDetails: any[] = [];



    logStructured(`OpenRouter Request`, { targetModel: target, originalModel: modelId });

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

    if (supportsReasoning) openRouterPayload.include_reasoning = true;
    // openRouterPayload.thinking = request.thinking; // No direct mapping for thinking in generic model config yet

    // TODO: Handle tool_choice from modelConfig if needed
    // if (request.tool_choice) {
    //   const { type, name } = request.tool_choice;
    //   if (type === 'tool' && name) openRouterPayload.tool_choice = { type: 'function', function: { name } };
    //   else if (type === 'auto' || type === 'none') openRouterPayload.tool_choice = type;
    // }

    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === 'function') adapter.reset();
    adapter.prepareRequest(openRouterPayload, request);

    await this.middlewareManager.beforeRequest({ modelId: target, messages, tools: convertedTools, stream: true });

    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            ...OPENROUTER_HEADERS,
        },
        body: JSON.stringify(openRouterPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`OpenRouter API Error: ${response.status} - ${errorText}`);
      throw new Error(`OpenRouter API Error: ${response.status} - ${errorText}`);
    }

    // Dropped params header is for Hono context, no longer needed in APIHandler
    // if (droppedParams.length > 0) c.header("X-Dropped-Params", droppedParams.join(", "));

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
