#!/usr/bin/env bun
/**
 * Universal adapter for Gemini CLI lifecycle hooks.
 * 
 * Maps Gemini CLI events to Gyst universal events and emits them to the
 * fire-and-forget queue.
 * 
 * Usage in ~/.gemini/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": "gyst-gemini-adapter session_start",
 *     "Prompt": "gyst-gemini-adapter prompt",
 *     ...
 *   }
 * }
 */

import { spawnSync } from "node:child_process";

const hookName = process.argv[2];
const payload = process.argv[3] || "{}";

if (!hookName) {
  process.exit(0);
}

// Map Gemini hooks to Gyst events
const MAPPING: Record<string, string> = {
  "SessionStart": "session_start",
  "SessionEnd": "session_end",
  "Prompt": "prompt",
  "ToolUse": "tool_use",
  "Error": "error",
  "PostCommit": "commit",
  "PostMerge": "pull",
  // Fallback to the hook name if no mapping exists
};

const eventType = MAPPING[hookName] || hookName;

// Emit to Gyst
spawnSync("bunx", ["gyst-mcp", "emit", eventType, payload], {
  stdio: "ignore",
  shell: true,
});

process.exit(0);
