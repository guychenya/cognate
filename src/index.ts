#!/usr/bin/env node

// Load .env file before anything else
import { config } from "dotenv";
config(); // Loads .env from current working directory

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Check for profile management commands
const args = process.argv.slice(2);
const firstArg = args[0];

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
} else if (firstArg === "init") {
  // Profile setup wizard
  import("./profile-commands.js").then((pc) => pc.initCommand());
} else if (firstArg === "profile") {
  // Profile management commands
  import("./profile-commands.js").then((pc) => pc.profileCommand(args.slice(1)));
} else if (firstArg === "update") {
  // Update command - check for and apply updates
  import("./update-checker.js").then(async (uc) => {
    const { getVersion } = await import("./cli.js");
    const shouldExit = await uc.checkForUpdates(getVersion(), {
      quiet: false,
      skipPrompt: false,
    });
    process.exit(shouldExit ? 0 : 1);
  });
} else {
  // CLI mode
  runCli();
}

/**
 * Run CLI mode
 */
async function runCli() {
  const { checkClaudeInstalled, runClaudeWithProxy } = await import("./claude-runner.js");
  const { parseArgs, getVersion } = await import("./cli.js");
  const { DEFAULT_PORT_RANGE, ENV } = await import("./config.js");
  const { selectModel, promptForApiKey } = await import("./model-selector.js");
  const { initLogger, getLogFilePath } = await import("./logger.js");
  const { findAvailablePort } = await import("./port-manager.js");
  const { createProxyServer } = await import("./proxy-server.js");
  const { checkForUpdates } = await import("./update-checker.js");

  // ANSI colors for output
  const GREEN = "\x1b[32m";
  const RESET = "\x1b[0m";

  /**
   * Read content from stdin
   */
  async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  try {
    // Parse CLI arguments
    let cliConfig: ClaudishConfig;
    try {
      cliConfig = await parseArgs(process.argv.slice(2));
    } catch (parseError: any) {
      // Catch errors specifically from parseArgs (which now throws instead of exits)
      console.error(`Error: ${parseError.message}`);
      process.exit(1);
    }

    // Initialize logger if debug mode with specified log level
    initLogger(cliConfig.debug, cliConfig.logLevel);

    // Show debug log location if enabled
    if (cliConfig.debug && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
    }

    // Check for updates (only in interactive mode, skip in JSON output mode)
    if (cliConfig.interactive && !cliConfig.jsonOutput) {
      const shouldExit = await checkForUpdates(getVersion(), {
        quiet: cliConfig.quiet,
        skipPrompt: false,
      });
      if (shouldExit) {
        process.exit(0);
      }
    }

    // Check if Claude Code is installed
    if (!(await checkClaudeInstalled())) {
      console.error("Error: Claude Code CLI is not installed");
      console.error("Install it from: https://claude.com/claude-code");
      process.exit(1);
    }

    // Prompt for API keys if not set (interactive mode only, not monitor mode)
    if (cliConfig.interactive && !cliConfig.monitor) {
      const hasOpenRouterKey = !!cliConfig.openrouterApiKey;
      const hasGeminiKey = !!process.env[ENV.GEMINI_API_KEY];

      if (!hasOpenRouterKey && !hasGeminiKey) {
        const { select, password } = await import("@inquirer/prompts");
        const apiChoice = await select({
          message: "Which API key would you like to set up?",
          choices: [
            { name: "OpenRouter (recommended for most models)", value: "openrouter" },
            { name: "Google Gemini (for direct Gemini access)", value: "gemini" },
            { name: "Skip API Key Setup (use existing or only monitor mode)", value: "skip" },
          ],
        });

        if (apiChoice === "openrouter") {
          cliConfig.openrouterApiKey = await promptForApiKey("OpenRouter");
          cliConfig.useGeminiNative = false;
          console.log("");
        } else if (apiChoice === "gemini") {
          const geminiKey = await password({
            message: "Enter your Google Gemini API key:",
            mask: "*",
          });
          if (geminiKey.trim()) {
            process.env[ENV.GEMINI_API_KEY] = geminiKey.trim();
            console.log(`${GREEN}✓${RESET} Gemini API key saved for this session`);
            cliConfig.useGeminiNative = true; // Explicitly set if chosen interactively
            console.log("");
          }
        } else if (apiChoice === "skip") {
          // If user skips, ensure useGeminiNative is not accidentally true
          if (!cliConfig.useGeminiNative) { // If already set by CLI arg, respect it
             cliConfig.useGeminiNative = false;
          }
        }
      } else if (hasOpenRouterKey && !cliConfig.useGeminiNative) {
        // If OpenRouter key is present and not explicitly using Gemini native
        console.log(`[claudish] Using OpenRouter API key from environment.`);
      } else if (hasGeminiKey && cliConfig.useGeminiNative) {
        // If Gemini key is present and explicitly using Gemini native
        console.log(`[claudish] Using Google Gemini API key from environment.`);
      } else {
        // Fallback for cases where one key is set but the other mode is implicitly chosen
        // e.g., OPENROUTER_API_KEY set, but also --use-gemini-native used with GEMINI_API_KEY also set
        // In this complex case, we prioritize what cliConfig.useGeminiNative tells us
        if (cliConfig.useGeminiNative) {
            console.log(`[claudish] Prioritizing Google Gemini API key due to --use-gemini-native flag.`);
        } else if (hasOpenRouterKey) {
            console.log(`[claudish] Using OpenRouter API key from environment.`);
        }
      }
    }

    // Show interactive model selector ONLY in interactive mode when model not specified
    if (cliConfig.interactive && !cliConfig.monitor && !cliConfig.model) {
      cliConfig.model = await selectModel({ freeOnly: cliConfig.freeOnly });
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model flag or CLAUDISH_MODEL env var)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag or set CLAUDISH_MODEL environment variable");
      console.error("Try: claudish --list-models");
      process.exit(1);
    }

    // Read prompt from stdin if --stdin flag is set
    if (cliConfig.stdin) {
      const stdinInput = await readStdin();
      if (stdinInput.trim()) {
        // Prepend stdin content to claudeArgs
        cliConfig.claudeArgs = [stdinInput, ...cliConfig.claudeArgs];
      }
    }

    // Find available port
    const port =
      cliConfig.port || (await findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end));

    // Start proxy server
    log(`[claudish] Gemini API Key (from env/prompt): ${process.env[ENV.GEMINI_API_KEY] ? "Set" : "Not Set"}`);
    const proxy = await createProxyServer({
      ...cliConfig,
      port: port,
      geminiApiKey: process.env[ENV.GEMINI_API_KEY], // Ensure this is passed
    });

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url);
    } finally {
      // Always cleanup proxy
      if (!cliConfig.quiet) {
        console.log("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      console.log("[claudish] Done\n");
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[claudish] Fatal error:", error);
    process.exit(1);
  }
}
