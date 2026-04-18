#!/usr/bin/env node
/**
 * Claude Code / Codex PostToolUse hook.
 *
 * Responsibilities:
 *  1. Always forward a `tool_use` event so the classifier can promote real
 *     failures to error_pattern entries.
 *  2. Sidecar emit for markdown edits:
 *       - `.md` under `decisions/` or `docs/**/plans/` → `plan_added` with content.
 *       - other `.md` edits → `md_change` (path only).
 *
 * Both emissions are concurrent (detached spawns) — never blocks the agent.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

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
  if (resp && typeof resp === "object" && typeof resp.filePath === "string") return resp.filePath;
  return null;
}

function isPlanPath(p) {
  if (/(^|\/)decisions\/\d{3,4}-[\w-]+\.md$/.test(p)) return true;
  if (/\/plans\/[^/]+\.md$/.test(p)) return true;
  return false;
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const hookInput = readHookInput();
  const toolName  = typeof hookInput.tool_name  === "string" ? hookInput.tool_name  : null;
  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : null;
  const errorText = extractError(hookInput);

  badge(errorText ? `capturing error (${toolName})` : `capturing tool use`);

  // 1. Emit tool_use — concurrent, detached.
  emitAsync(gyst, "tool_use", { tool: toolName, sessionId, error: errorText });

  // 2. Sidecar: markdown-aware emission on Write/Edit — also concurrent.
  const isWriteOrEdit = toolName === "Write" || toolName === "Edit";
  const filePath = isWriteOrEdit ? extractFilePath(hookInput) : null;
  if (filePath && filePath.endsWith(".md")) {
    if (isPlanPath(filePath)) {
      let content = "";
      try {
        if (existsSync(filePath) && statSync(filePath).size <= MAX_CONTENT_BYTES) {
          content = readFileSync(filePath, "utf8");
        }
      } catch { /* non-fatal */ }
      emitAsync(gyst, "plan_added", { path: filePath, content, sessionId });
    } else {
      emitAsync(gyst, "md_change", { path: filePath, sessionId });
    }
  }

  process.stdout.write(JSON.stringify({ continue: true }));
} catch {
  process.stdout.write(JSON.stringify({ continue: true }));
}
