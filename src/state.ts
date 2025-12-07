/**
 * Global state management for the application.
 *
 * This module holds the parsed configuration and makes it available
 * to other parts of the application.
 */

import type { ClaudishConfig } from "./types.js";

let appConfig: ClaudishConfig | null = null;

/**
 * Sets the global application configuration.
 * This should only be called once from the main entry point.
 * @param config The configuration object parsed from CLI args and env vars.
 */
export function setConfig(config: ClaudishConfig): void {
  if (appConfig) {
    throw new Error("Application config has already been set.");
  }
  appConfig = config;
}

/**
 * Retrieves the global application configuration.
 * Throws an error if the configuration has not been set yet.
 * @returns The global configuration object.
 */
export function getConfig(): ClaudishConfig {
  if (!appConfig) {
    throw new Error("Application config has not been initialized. Call setConfig first.");
  }
  return appConfig;
}
