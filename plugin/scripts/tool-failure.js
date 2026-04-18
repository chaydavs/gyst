#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  const error = typeof input.error === "string" ? input.error : null;
  if (error) {
    badge("extracting error pattern");
    emitAsync(gyst, "tool_failure", {
      error,
      toolName: typeof input.tool_name === "string" ? input.tool_name : null,
      sessionId: typeof input.session_id === "string" ? input.session_id : null,
      toolInput: input.tool_input ?? null,
    });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
