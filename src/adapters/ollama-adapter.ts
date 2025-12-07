/**
 * Ollama adapter for handling model-specific behaviors.
 *
 * This adapter prepares requests for the Ollama API, which is largely
 * compatible with the OpenAI API but does not support parameters like

 * 'reasoning_effort'. It also allows users to connect to a custom
 * Ollama host.
 */

import { BaseModelAdapter, AdapterResult } from "./base-adapter.js";
import { log } from "../logger.js";
import { getConfig } from '../config.js';

export class OllamaAdapter extends BaseModelAdapter {
  private adapterName = "OllamaAdapter";

  processTextContent(
    textContent: string,
    accumulatedText: string
  ): AdapterResult {
    // Ollama API responses are standard, so no special text
    // processing is needed.
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Prepares the request for the Ollama API by removing any unsupported
   * parameters, such as 'thinking' or 'reasoning_effort'.
   */
  override prepareRequest(request: any, originalRequest: any): any {
    if (request.thinking || request.reasoning_effort) {
      log(`[${this.adapterName}] Stripping unsupported 'thinking' and 'reasoning_effort' parameters for Ollama.`);
      delete request.thinking;
      delete request.reasoning_effort;
    }
    return request;
  }

  /**
   * This adapter is explicitly selected via a command-line flag,
   * so this method will check for that configuration.
   */
  shouldHandle(modelId: string): boolean {
    const config = getConfig();
    return config.adapter === 'ollama';
  }

  getName(): string {
    return this.adapterName;
  }
}
