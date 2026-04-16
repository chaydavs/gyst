#!/usr/bin/env node
/**
 * Claude Code / Codex PostToolUse hook.
 *
 * Responsibilities:
 *  1. Always forward a `tool_use` event so the classifier can promote real
 *     failures to error_pattern entries (rather than dropping every call).
 *  2. Sidecar emit for markdown edits:
 *       - `.md` edits under `decisions/` or `docs/**/plans/` → `plan_added`
 *         with the file contents (up to 64KB) for the ADR/plan parsers.
 *       - other `.md` edits → `md_change` (path only, low signal).
 *
 * Fire-and-forget: never blocks the agent.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

const MAX_CONTENT_BYTES = 64 * 1024;

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

function extractError(hookInput) {
  const resp = hookInput.tool_response;
  if (resp && typeof resp === "object") {
    if (resp.is_error === true && typeof resp.content === "string") return resp.content;
    if (typeof resp.error === "string") return resp.error;
    if (typeof resp.stderr === "string" && resp.stderr.length > 0) return resp.stderr;
  }
  return "";
}

function extractFilePath(hookInput) {
  const input = hookInput.tool_input;
  if (input && typeof input === "object") {
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.notebook_path === "string") return input.notebook_path;
  }
  const resp = hookInput.tool_response;
  if (resp && typeof resp === "object" && typeof resp.filePath === "string") {
    return resp.filePath;
  }
  return null;
}

function isPlanPath(path) {
  // ADR: decisions/NNN-slug.md. Plan: any .md under a plans/ directory.
  if (/(^|\/)decisions\/\d{3,4}-[\w-]+\.md$/.test(path)) return true;
  if (/\/plans\/[^/]+\.md$/.test(path)) return true;
  return false;
}

function emit(gyst, eventType, payload) {
  spawnSync(gyst, ["emit", eventType], {
    timeout: 2000,
    input: JSON.stringify(payload),
    stdio: ["pipe", "ignore", "ignore"],
  });
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const toolName = typeof hookInput.tool_name === "string" ? hookInput.tool_name : null;
  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : null;

  // 1. Always emit the canonical tool_use event.
  emit(gyst, "tool_use", {
    tool: toolName,
    sessionId,
    error: extractError(hookInput),
  });

  // 2. Sidecar: markdown-aware emission on successful Write/Edit.
  const isWriteOrEdit = toolName === "Write" || toolName === "Edit";
  const filePath = isWriteOrEdit ? extractFilePath(hookInput) : null;
  if (filePath && filePath.endsWith(".md")) {
    if (isPlanPath(filePath)) {
      // Read a bounded chunk for the ADR / plan parser.
      let content = "";
      try {
        if (existsSync(filePath) && statSync(filePath).size <= MAX_CONTENT_BYTES) {
          content = readFileSync(filePath, "utf8");
        }
      } catch {
        // Read failure is non-fatal; emit with empty content — classifier
        // still assigns plan_added signal based on path alone.
      }
      emit(gyst, "plan_added", { path: filePath, content, sessionId });
    } else {
      emit(gyst, "md_change", { path: filePath, sessionId });
    }
  }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
