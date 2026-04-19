#!/usr/bin/env node
/**
 * Claude Code / Codex SessionStart hook.
 *
 * Records the session_start event and injects recent-context markdown as
 * `additionalContext`. Output must be valid JSON for Claude Code plugin hooks.
 *
 * Never blocks the agent: all failures swallow to `{"continue": true}`.
 */
import { spawnSync, spawn } from "node:child_process";
import { badge, emitAsync } from "./badge.js";

function tryCommand(cmd, args) {
  const result = spawnSync(cmd, args, {
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  if (result.status === 0 && typeof result.stdout === "string") return result.stdout;
  return "";
}

try {
  const gyst = process.env.GYST_BIN || "gyst";

  badge("injecting team context");

  // Fire-and-forget: session_start event + self-document KB refresh.
  // self-document runs detached so it never blocks session startup.
  emitAsync(gyst, "session_start", {});
  try {
    const selfDoc = spawn(gyst, ["self-document", "--skip-ghosts", "--no-llm"], {
      detached: true,
      stdio: "ignore",
    });
    selfDoc.unref();
  } catch {
    // non-fatal — KB refresh failure should not block the session
  }

  // inject-context must be synchronous because its output goes into the
  // additionalContext response field that Claude Code reads immediately.
  const context = tryCommand(gyst, ["inject-context", "--always-on", "--graph-traverse"]);

  const response = { continue: true };
  if (context.trim().length > 0) response.additionalContext = context;
  process.stdout.write(JSON.stringify(response));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
