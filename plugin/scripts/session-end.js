#!/usr/bin/env node
/**
 * Session end hook for Claude Code, Gemini CLI, Cursor, Windsurf, and Codex CLI.
 *
 * Records session_end so downstream distillation can group events per
 * session. Never blocks the agent.
 */
import { spawn } from "node:child_process";
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const payload = {
    sessionId: input.session_id,
    reason: input.stop_hook_active ? "stop" : "session_end",
  };

  badge("distilling session knowledge");
  emitAsync(gyst, "session_end", payload);

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

  // Cleanup flag file for this session so the next session starts fresh
  try {
    const { join: pathJoin } = await import("node:path");
    const { tmpdir: osTmpdir } = await import("node:os");
    const { unlinkSync: fsUnlink, existsSync: fsExists } = await import("node:fs");
    const sessionFlagFile = pathJoin(osTmpdir(), ".gyst-sessions", `${input.session_id ?? "unknown"}-injected`);
    if (fsExists(sessionFlagFile)) fsUnlink(sessionFlagFile);
  } catch { /* non-fatal */ }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
