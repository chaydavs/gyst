#!/usr/bin/env node
/**
 * Shared status badge + async emitter for gyst hook scripts.
 *
 * badge()     — writes a compact ANSI box to stderr so users see gyst is active.
 * emitAsync() — spawns `gyst emit <event>` as a detached child that outlives
 *               the hook process; returns immediately (true fire-and-forget).
 */
import { spawn } from "node:child_process";

const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN  = "\x1b[36m";
const RST   = "\x1b[0m";

/**
 * Print a compact status box to stderr.
 * @param {string} action - Short label (≤26 chars) describing what gyst is doing.
 */
export function badge(action) {
  const label = action.slice(0, 26).padEnd(26);
  process.stderr.write(
    `${DIM}┌─ ${GREEN}gyst${RST}${DIM} ──────────────────────┐${RST}\n` +
    `${DIM}│${RST} ${CYAN}◆${RST} ${label} ${DIM}│${RST}\n` +
    `${DIM}└─────────────────────────────┘${RST}\n`
  );
}

/**
 * Fire-and-forget async emit. Spawns gyst as a detached process so the
 * hook can return {continue:true} immediately without waiting for gyst.
 *
 * @param {string} bin           - Path/name of the gyst binary.
 * @param {string} eventType     - Event name passed to `gyst emit <eventType>`.
 * @param {object} payload       - JSON payload written to the child's stdin.
 */
export function emitAsync(bin, eventType, payload) {
  try {
    const child = spawn(bin, ["emit", eventType], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.unref();
  } catch {
    // spawn failure is non-fatal — hook always continues
  }
}
