#!/usr/bin/env node
/**
 * Claude Code / Codex Stop / SessionEnd / SubagentStop hook.
 *
 * Records session_end so downstream distillation can group events per
 * session. Never blocks the agent.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const payload = {
    sessionId: typeof hookInput.session_id === "string" ? hookInput.session_id : null,
    reason: hookInput.stop_hook_active === true ? "stop" : "session_end",
  };

  badge("distilling session knowledge");
  emitAsync(gyst, "session_end", payload);

  // Fire-and-forget KB refresh at session end — picks up any files changed
  // during the session. --no-llm ensures zero cost / no API key required.
  try {
    const selfDoc = spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    selfDoc.unref();
  } catch {
    // non-fatal
  }

  try {
    const mine = spawn(gyst, ["mine", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    mine.unref();
  } catch {
    // non-fatal
  }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
