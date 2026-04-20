#!/usr/bin/env node
/**
 * Shared stdin normalization for gyst hook scripts.
 *
 * Each AI tool sends hook payloads with different field names.
 * This module normalizes them to a single canonical shape so all
 * hook scripts work regardless of which tool is running them.
 */
import { readFileSync } from "node:fs";

/**
 * Normalizes a raw hook payload object to the canonical shape.
 * Field name priority (first non-null string wins):
 *   session_id:       session_id → sessionId
 *   tool_name:        tool_name  → toolName → tool
 *   transcript_path:  transcript_path → transcriptPath
 *   prompt_text:      prompt → prompt_text → promptText
 *   stop_hook_active: stop_hook_active (boolean, default false)
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ session_id: string|null, tool_name: string|null, transcript_path: string|null, prompt_text: string|null, stop_hook_active: boolean }}
 */
export function normalizeHookInput(raw) {
  const str = (v) => (typeof v === "string" ? v : null);
  return {
    session_id:       str(raw.session_id)       ?? str(raw.sessionId)       ?? null,
    tool_name:        str(raw.tool_name)         ?? str(raw.toolName)        ?? str(raw.tool) ?? null,
    transcript_path:  str(raw.transcript_path)   ?? str(raw.transcriptPath)  ?? null,
    prompt_text:      str(raw.prompt)            ?? str(raw.prompt_text)     ?? str(raw.promptText) ?? null,
    stop_hook_active: raw.stop_hook_active === true,
  };
}

/**
 * Reads stdin (fd 0), parses JSON, and returns a normalized input object.
 * Returns all-null canonical object on any parse failure.
 *
 * @returns {{ session_id: string|null, tool_name: string|null, transcript_path: string|null, prompt_text: string|null, stop_hook_active: boolean }}
 */
export function readNormalizedInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return normalizeHookInput({});
    return normalizeHookInput(JSON.parse(raw));
  } catch {
    return normalizeHookInput({});
  }
}
