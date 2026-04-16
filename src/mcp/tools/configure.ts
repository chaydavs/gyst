/**
 * The `configure` MCP tool — agents tune Gyst at runtime.
 *
 * Lets the user prompt their AI agent with things like
 *   "turn on team mode"
 *   "bump recall budget to 8k tokens"
 *   "auto-export entries to markdown"
 * and have the agent apply them without the user hand-editing
 * `.gyst-wiki.json`.
 *
 * Mutates the project config file in place; every field is optional so a
 * single call can flip one knob or several. Fields that would invalidate the
 * live database connection (`dbPath`, `wikiDir`, `globalDbPath`) are
 * deliberately NOT exposed — changing those requires a server restart and is
 * handled by `gyst install` / manual editing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../utils/logger.js";
import type { ToolContext } from "../register-tools.js";

const CONFIG_FILE_NAME = ".gyst-wiki.json";

// Subset of loadConfig()'s schema that is safe to mutate at runtime.
// Matches the definitions in src/utils/config.ts — keep these in sync if
// the canonical schema changes.
const ConfigureInput = z.object({
  teamMode: z.boolean().optional(),
  autoExport: z.boolean().optional(),
  maxRecallTokens: z.number().int().positive().max(32_000).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
});

type ConfigureInputType = z.infer<typeof ConfigureInput>;

/**
 * Reads `.gyst-wiki.json` into a plain object (empty object when the file is
 * missing). Malformed JSON throws so the caller can surface the error.
 */
function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/**
 * Writes the merged config back, preserving any untouched keys already on
 * disk. Trailing newline matches the convention used by `gyst team init`.
 */
function writeConfigFile(configPath: string, next: Record<string, unknown>): void {
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export function registerConfigureTool(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    "configure",
    "Update Gyst project configuration at runtime. Use when the user asks to turn on team mode, change recall size, toggle auto-export, or adjust confidence/log thresholds. Only supplied fields are changed.",
    ConfigureInput.shape,
    async (input: ConfigureInputType) => {
      const parseResult = ConfigureInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return {
          content: [{ type: "text" as const, text: `Invalid configure input: ${msg}` }],
          isError: true,
        };
      }

      const valid = parseResult.data;
      const updates = Object.entries(valid).filter(([, v]) => v !== undefined);

      if (updates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No fields supplied. Accepted keys: teamMode, autoExport, maxRecallTokens, confidenceThreshold, logLevel.",
            },
          ],
        };
      }

      const configPath = join(process.cwd(), CONFIG_FILE_NAME);

      let current: Record<string, unknown>;
      try {
        current = readConfigFile(configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to read ${configPath}: ${msg}` }],
          isError: true,
        };
      }

      const next = { ...current };
      const before: Record<string, unknown> = {};
      for (const [key, value] of updates) {
        before[key] = current[key];
        next[key] = value;
      }

      try {
        writeConfigFile(configPath, next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to write ${configPath}: ${msg}` }],
          isError: true,
        };
      }

      logger.info("configure tool applied", { updates: Object.fromEntries(updates) });

      const lines = updates.map(
        ([key, value]) => `  - ${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(value)}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Updated .gyst-wiki.json:",
              ...lines,
              "",
              "Some changes (logLevel) apply to new log calls immediately.",
              "Scope-related changes (teamMode) apply to future writes — existing entries keep their original scope.",
            ].join("\n"),
          },
        ],
      };
    },
  );
}
