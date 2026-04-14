/**
 * Auto-installer for Gyst MCP configuration.
 *
 * Detects which AI coding tools are present by checking for their config files,
 * then merges the Gyst MCP server entry into each tool's config without
 * overwriting other registered servers.
 *
 * Supported tools:
 *  - Claude Code  — `.mcp.json` (project-level)
 *  - Cursor       — `.cursor/mcp.json`
 *  - Gemini CLI   — `~/.gemini/settings.json`
 *  - Windsurf     — `~/.codeium/windsurf/mcp_config.json`
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape injected under `mcpServers["gyst"]` in each tool config. */
interface GystServerConfig {
  readonly command: string;
  readonly args: string[];
}

/** The relevant portion of any supported tool config file. */
interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Descriptor for a single AI tool's MCP configuration.
 */
interface ToolDescriptor {
  /** Human-readable name returned in the result list. */
  readonly name: string;
  /**
   * Absolute path to the config file.  For project-relative paths the caller
   * provides `projectDir`; for user-home paths we use `homedir()`.
   */
  configPath(projectDir: string): string;
}

const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "Claude Code",
    configPath: (projectDir) => join(projectDir, ".mcp.json"),
  },
  {
    name: "Cursor",
    configPath: (projectDir) => join(projectDir, ".cursor", "mcp.json"),
  },
  {
    name: "Gemini CLI",
    configPath: (_projectDir) => join(homedir(), ".gemini", "settings.json"),
  },
  {
    name: "Windsurf",
    configPath: (_projectDir) =>
      join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads and parses a JSON config file.  Returns an empty object when the file
 * does not exist.
 *
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed config object.
 * @throws If the file exists but cannot be parsed as JSON.
 */
function readJsonConfig(filePath: string): McpConfig {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as McpConfig;
}

/**
 * Merges the Gyst server entry into a config object without mutating the
 * original.
 *
 * @param config - Existing config object.
 * @param gystConfig - The Gyst server entry to inject.
 * @returns A new config object with `mcpServers.gyst` set.
 */
function mergeGystEntry(
  config: McpConfig,
  gystConfig: GystServerConfig,
): McpConfig {
  const existingServers =
    typeof config.mcpServers === "object" && config.mcpServers !== null
      ? config.mcpServers
      : {};

  return {
    ...config,
    mcpServers: {
      ...existingServers,
      gyst: gystConfig,
    },
  };
}

/**
 * Writes a config object to disk as formatted JSON.  Creates parent
 * directories if they do not exist.
 *
 * @param filePath - Destination file path.
 * @param config - Config object to serialise.
 */
function writeJsonConfig(filePath: string, config: McpConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects installed AI coding tools and injects the Gyst MCP server config
 * into each one that is present.
 *
 * The function is idempotent — running it multiple times will update the
 * `gyst` entry but will not create duplicates or touch other server entries.
 *
 * @param projectDir - Absolute path to the project root.  Used to locate
 *   project-level config files (e.g. `.mcp.json`).
 * @returns List of tool names that were successfully configured.
 */
export function installForDetectedTools(projectDir: string): string[] {
  const absoluteProjectDir = resolve(projectDir);

  // Use the published npm package entry point — works in any consumer project.
  // Both `setup` and `install` produce the identical config via this constant.
  const gystConfig: GystServerConfig = {
    command: "bunx",
    args: ["gyst-mcp", "serve"],
  };

  const configured: string[] = [];

  for (const tool of TOOL_DESCRIPTORS) {
    const configPath = tool.configPath(absoluteProjectDir);

    if (!existsSync(configPath) && tool.name !== "Claude Code" && tool.name !== "Cursor") {
      // For home-directory tools, only write if the parent directory already
      // exists (meaning the tool is actually installed).
      const parentDir = dirname(configPath);
      if (!existsSync(parentDir)) {
        logger.debug("Skipping tool — parent config dir not found", {
          tool: tool.name,
          parentDir,
        });
        continue;
      }
    }

    try {
      const existing = readJsonConfig(configPath);
      const merged = mergeGystEntry(existing, gystConfig);
      writeJsonConfig(configPath, merged);

      logger.info("MCP config written", { tool: tool.name, configPath });
      configured.push(tool.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to write MCP config for tool", {
        tool: tool.name,
        configPath,
        error: msg,
      });
    }
  }

  return configured;
}
