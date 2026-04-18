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
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  if (filePath && filePath.endsWith(".md")) {
    badge("ingesting changed MD file");
    emitAsync(gyst, "md_changed", { filePath, reason: "file_changed" });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
