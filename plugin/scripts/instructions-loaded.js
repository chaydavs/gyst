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
  if (filePath) {
    badge("ingesting instructions file");
    emitAsync(gyst, "md_changed", {
      filePath,
      memoryType: typeof input.memory_type === "string" ? input.memory_type : "Project",
      reason: "instructions_loaded",
    });
  }
  process.stdout.write(JSON.stringify({ continue: true }));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
