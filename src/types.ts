// AUTO-GENERATED from shared/recommended-models.md
// DO NOT EDIT MANUALLY - Run 'bun run extract-models' to regenerate

// OpenRouter Models - Top Recommended for Development (Priority Order)
export const OPENROUTER_MODELS = [
  "x-ai/grok-code-fast-1",
  "minimax/minimax-m2",
  "google/gemini-2.5-flash",
  "openai/gpt-5",
  "openai/gpt-5.1-codex",
  "qwen/qwen3-vl-235b-a22b-instruct",
  "openrouter/polaris-alpha",
  "custom",
] as const;

export type OpenRouterModel = (typeof OPENROUTER_MODELS)[number];

// CLI Configuration
export interface ClaudishConfig {
  model?: OpenRouterModel | string; // Optional - will prompt if not provided
  port?: number;
  autoApprove: boolean;
  dangerous: boolean;
  interactive: boolean;
  debug: boolean;
  logLevel: "debug" | "info" | "minimal"; // Log verbosity level (default: info)
  quiet: boolean; // Suppress [claudish] log messages (default true in single-shot mode)
  jsonOutput: boolean; // Output in JSON format for tool integration
  monitor: boolean; // Monitor mode - proxy to real Anthropic API and log everything
  stdin: boolean; // Read prompt from stdin instead of args
  openrouterApiKey?: string; // Optional in monitor mode
  anthropicApiKey?: string; // Required in monitor mode
  geminiApiKey?: string; // Add geminiApiKey to config
  useGeminiNative?: boolean; // Explicitly use native Gemini handler
  agent?: string; // Agent to use for execution (e.g., "frontend:developer")
  freeOnly?: boolean; // Show only free models in selector
  profile?: string; // Profile name to use for model mapping
  claudeArgs: string[];

  // Model Mapping
  modelOpus?: string;
  modelSonnet?: string;
  modelHaiku?: string;
  modelSubagent?: string;

  // Cost tracking
  costTracking?: boolean;
  auditCosts?: boolean;
  resetCosts?: boolean;

  // Adapter configuration
  adapter?: 'ollama' | 'openrouter';
  ollamaHost?: string;
}

// Anthropic API Types
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  system?: string;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// OpenRouter API Types
export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Proxy Server
export interface ProxyServer {
  port: number;
  url: string;
  shutdown: () => Promise<void>;
}

// Generic Content Block for multimodal input
export interface GenericContentBlock {
  type: "text" | "image_url" | "tool_use" | "tool_result";
  text?: string; // For type: "text"
  image_url?: { url: string }; // For type: "image_url"
  id?: string; // For tool_use/tool_result
  name?: string; // For tool_use
  input?: Record<string, any>; // For tool_use arguments
  tool_use_id?: string; // For tool_result
  content?: string | Record<string, any>; // For tool_result content
}

// Generic Message Interface (for both input and output)
export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string | GenericContentBlock[];
  // Optional: For assistant messages that contain tool calls without text
  tool_calls?: ToolCall[];
  // Optional: For tool messages, to link back to the tool call
  tool_call_id?: string;
}

// Generic Model Configuration for generation parameters
export interface ModelConfig {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
}

// Generic Tool Call structure
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  signature?: string; // Optional: for thought signatures
}

// Generic Generation Result
export interface GenerationResult {
  fullContent: string;
  toolCalls: ToolCall[];
  reasoningDetails: any[]; // Raw reasoning details from the model
}

// Generic API Handler Interface
export interface APIHandler {
  generate(
    messages: Message[],
    modelId: string,
    onChunk: (chunk: string) => void,
    modelConfig?: ModelConfig,
    tools?: any[], // New: Optional tools parameter
  ): Promise<GenerationResult>;
}

