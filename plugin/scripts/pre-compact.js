#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { badge, emitAsync } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  const gyst = process.env.GYST_BIN || "gyst";
  const input = readHookInput();
  badge("harvesting before compaction");
  emitAsync(gyst, "session_end", {
    sessionId: typeof input.session_id === "string" ? input.session_id : null,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    reason: "pre_compact",
  });

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
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
