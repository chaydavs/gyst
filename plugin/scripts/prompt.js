#!/usr/bin/env node
/**
 * UserPromptSubmit hook for Claude Code, Cursor, and Codex CLI.
 *
 * On the FIRST prompt of a session: runs `gyst recall --format json` against
 * the prompt text and injects task-relevant context as `additionalContext`.
 *
 * On subsequent prompts: purely observational — forwards a minimal payload to
 * `gyst emit prompt` for classification. Fire-and-forget; never blocks the agent.
 *
 * First-prompt detection uses a flag file in tmpdir keyed by session_id.
 * The flag is written in ALL paths (success and failure) to prevent infinite retry.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { badge, emitAsync } from "./badge.js";
import { readNormalizedInput } from "./normalize-stdin.js";

const TYPE_ICONS = {
  ghost_knowledge: "⚠️",
  convention: "📏",
  error_pattern: "🐛",
  decision: "🏛️",
  learning: "💡",
  workflow: "📋",
  md_doc: "📄",
};

/**
 * Formats recall results as a markdown context block for injection.
 * @param {object} data - Parsed JSON from `gyst recall --format json`
 * @returns {string} Formatted markdown string
 */
function formatContext(data) {
  const intent = data.intent ?? "conceptual";
  const lines = ["## Task-Relevant Context (from gyst)"];
  if (intent !== "conceptual") {
    lines.push(`_Based on your ${intent} query, here's relevant knowledge:_\n`);
  }
  for (const r of data.results) {
    const icon = TYPE_ICONS[r.type] ?? "📌";
    lines.push(`### ${icon} ${r.title}`);
    lines.push(r.content.slice(0, 500));
    lines.push("");
  }
  return lines.join("\n");
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readNormalizedInput();
  const sessionId = input.session_id ?? "unknown";
  const promptText = input.prompt_text ?? "";

  // -------------------------------------------------------------------------
  // Flag file setup — tracks whether we've already injected for this session
  // -------------------------------------------------------------------------
  const flagDir = join(tmpdir(), ".gyst-sessions");
  const flagFile = join(flagDir, `${sessionId}-injected`);

  // Opportunistic cleanup: delete flag files older than 24h
  try {
    mkdirSync(flagDir, { recursive: true });
    const now = Date.now();
    for (const f of readdirSync(flagDir)) {
      const fp = join(flagDir, f);
      try {
        if (now - statSync(fp).mtimeMs > 86_400_000) unlinkSync(fp);
      } catch { /* ignore stale-file errors */ }
    }
  } catch { /* ignore directory errors */ }

  const isFirstPrompt = !existsSync(flagFile);

  // Write flag immediately in ALL paths so a crash does not cause infinite retry
  try {
    writeFileSync(flagFile, "", { flag: "w" });
  } catch { /* ignore */ }

  // -------------------------------------------------------------------------
  // Async event emit — observational, fire-and-forget (existing behavior)
  // -------------------------------------------------------------------------
  const payload = {
    text:      promptText,
    sessionId: sessionId,
    cwd:       input.cwd ?? null,
  };

  badge("recording prompt");
  emitAsync(gyst, "prompt", payload);

  // -------------------------------------------------------------------------
  // First-prompt context injection
  // -------------------------------------------------------------------------
  if (!isFirstPrompt || !promptText) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  try {
    const result = spawnSync(
      gyst,
      ["recall", promptText.slice(0, 500), "-n", "3", "--format", "json"],
      {
        timeout: 1500,
        encoding: "utf8",
        cwd: input.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout);
      if (data.results && data.results.length > 0) {
        const formatted = formatContext(data);
        process.stdout.write(
          JSON.stringify({ continue: true, additionalContext: formatted }),
        );
        process.exit(0);
      }
    }
  } catch { /* fail silent — fall through to bare continue */ }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
