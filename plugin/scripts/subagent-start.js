#!/usr/bin/env node
/**
 * SubagentStart hook — inject ghost knowledge into every spawned subagent.
 * Uses execFileSync with an argument array (no shell) to avoid injection risk.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { badge } from "./badge.js";

function readHookInput() {
  try { const r = readFileSync(0, "utf8").trim(); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}

try {
  readHookInput(); // consume stdin
  const gystBin = process.env.GYST_BIN || "gyst";
  badge("injecting subagent context");

  let ghostContext = "";
  try {
    // execFileSync with array args — no shell, no injection risk
    const raw = execFileSync(
      gystBin,
      ["recall", "--type", "ghost_knowledge", "--limit", "3", "--format", "json"],
      { timeout: 2000, encoding: "utf8" }
    );
    const entries = JSON.parse(raw);
    if (Array.isArray(entries) && entries.length > 0) {
      ghostContext = "## Team Knowledge (gyst)\n" +
        entries.map((e) => `### ${e.title}\n${e.content}`).join("\n\n");
    }
  } catch {
    // ghost context is best-effort — never block the subagent
  }

  process.stdout.write(JSON.stringify(
    ghostContext ? { continue: true, additionalContext: ghostContext } : { continue: true }
  ));
} catch { process.stdout.write(JSON.stringify({ continue: true })); }
