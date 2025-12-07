/**
 * Model adapters for handling model-specific quirks
 */

export { BaseModelAdapter, DefaultAdapter } from "./base-adapter.js";
export type { ToolCall, AdapterResult } from "./base-adapter.js";
export * from "./grok-adapter.js";
export * from "./gemini-adapter.js";
export * from "./minimax-adapter.js";
export * from "./qwen-adapter.js";
export * from "./deepseek-adapter.js";
export * from "./ollama-adapter.js";
export { AdapterManager } from "./adapter-manager.js";
