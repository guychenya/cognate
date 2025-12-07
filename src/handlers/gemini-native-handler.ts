import { GoogleGenerativeAI } from "@google/generative-ai";
import { APIHandler, GenerationResult, Message, ModelConfig, ToolCall } from "../types.js";
import { ENV } from "../config.js";
import { log } from "../logger.js";
import { generateUniqueId } from "../utils.js";

export class GeminiNativeHandler implements APIHandler {
  private genAI: GoogleGenerativeAI;
  // private modelConfig: ModelConfig; // modelConfig is now passed per-request

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("API key cannot be empty.");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async generate(
    messages: Message[],
    modelId: string,
    onChunk: (chunk: string) => void,
    modelConfig?: ModelConfig,
    tools?: any[], // New: Optional tools parameter
  ): Promise<GenerationResult> {
    const geminiMessages = messages.map((msg) => {
      let role: "user" | "model" | "function" | undefined;
      if (msg.role === "user") role = "user";
      else if (msg.role === "assistant") role = "model";
      else if (msg.role === "tool") role = "function"; // Gemini expects "function" for tool results

      const parts: any[] = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push({ text: block.text });
          else if (block.type === "image_url" && block.image_url) {
            // Gemini expects base64 for image parts
            // Assuming image_url.url is a data URI or can be fetched and converted
            // For simplicity, we'll just pass the URL string, though it might need preprocessing
            parts.push({ image: {
              inlineData: {
                mimeType: "image/png", // Placeholder, ideally this would be dynamic
                data: block.image_url.url.split(',')[1] // Extract base64 data
              }
            }});
          } else if (block.type === "tool_use" && block.name && block.input) {
            // This case should primarily be handled by Gemini's tool_calls in assistant response
            // If it's in user message, it's a tool result
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input,
              },
            });
          } else if (block.type === "tool_result" && msg.tool_call_id && block.content) {
            parts.push({
              functionResponse: {
                name: (block.id || block.tool_use_id) as string, // Assuming tool_use_id or id maps to function name
                response: {
                  name: (block.id || block.tool_use_id) as string,
                  content: block.content,
                },
              },
            });
          }
        }
      }

      // Handle assistant's tool_calls (Gemini will generate these, not typically sent in input)
      // If we receive them as input, we should map them to functionCall
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.args,
            },
          });
        }
      }

      return {
        role,
        parts,
      };
    }).filter(msg => msg.role !== undefined); // Filter out messages with unhandled roles (e.g., system for now)

    // Gemini API only allows text input for the last user message in sendMessageStream
    // If the last message is a user message, we extract its content for sendMessageStream
    // The history will contain all messages except the last one for sendMessageStream
    let lastUserMessageContent: string | undefined;
    if (geminiMessages.length > 0 && geminiMessages[geminiMessages.length - 1].role === "user") {
        const lastMessage = geminiMessages.pop();
        if (lastMessage && lastMessage.parts && lastMessage.parts.length > 0) {
            // Assuming the last user message's content can be combined into a single string for sendMessageStream
            lastUserMessageContent = lastMessage.parts.map((part: any) => part.text || JSON.stringify(part)).join("");
        }
    }


    const chatParams: any = {
      history: geminiMessages,
      generationConfig: {
        maxOutputTokens: modelConfig?.maxOutputTokens,
        temperature: modelConfig?.temperature,
        topP: modelConfig?.topP,
        topK: modelConfig?.topK,
      },
    };

    if (tools && tools.length > 0) {
      chatParams.tools = tools.map((tool: any) => ({
        functionDeclarations: [{
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema, // Assuming input_schema is directly compatible
        }],
      }));
    }

    const model = this.genAI.getGenerativeModel({ model: modelId });
    const chat = model.startChat(chatParams);

    const result = await chat.sendMessageStream(
      lastUserMessageContent || (messages[messages.length - 1].content as string),
    );

    let fullContent = "";
    const toolCalls: ToolCall[] = [];
    const reasoningDetails: any[] = []; // Gemini does not have direct equivalent for now

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      onChunk(chunkText);
      fullContent += chunkText;

      // Extract tool calls from Gemini's response
      const candidates = chunk.candidates;
      if (candidates && candidates.length > 0) {
        for (const candidate of candidates) {
          if (candidate.content && candidate.content.parts) {
            for (const part of candidate.content.parts) {
              if (part.functionCall) {
                toolCalls.push({
                  id: generateUniqueId(), // Generate a unique ID for the tool call
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                });
              }
            }
          }
        }
      }
    }

    return {
      fullContent,
      toolCalls,
      reasoningDetails,
    };
  }
}
