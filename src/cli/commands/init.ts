/**
 * gyst init — one-command bootstrap that makes the AI agent context layer
 * feel magical. Orchestrates existing KB phases with a clean progressive UI.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RST    = "\x1b[0m";

/** Visible length of a string — strips ANSI escape codes. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ---------------------------------------------------------------------------
// Box geometry
// ---------------------------------------------------------------------------

/** Total box width (including │ on both sides). */
const BOX_WIDTH = 51;
/** Interior content width (BOX_WIDTH - 2 for borders). */
const BOX_INNER = BOX_WIDTH - 2; // 49

/** Pad a string to `n` visible chars by appending spaces. */
function padVis(s: string, n: number): string {
  const pad = n - visLen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function boxTop(title: string): string {
  const dashes = BOX_WIDTH - 5 - title.length; // ╭─ {title} {dashes}╮
  return `╭─ ${title} ${"─".repeat(Math.max(0, dashes))}╮\n`;
}

function boxBottom(): string {
  return `╰${"─".repeat(BOX_INNER)}╯\n`;
}

/** Render one interior line. `content` may contain ANSI codes; visible width must be ≤ BOX_INNER-2. */
function boxLine(content: string): string {
  return `│  ${padVis(content, BOX_INNER - 2)}│\n`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KBStats {
  readonly conventions: number;
  readonly decisions: number;
  readonly errors: number;
  readonly learnings: number;
}

export interface InitOptions {
  readonly noLlm: boolean;
  readonly noGit: boolean;
  readonly force: boolean;
  readonly projectDir: string;
}

// ---------------------------------------------------------------------------
// ProgressUI
// ---------------------------------------------------------------------------

/**
 * Sequential ANSI box renderer for the init command.
 *
 * Each method prints one or more lines. No cursor movement — safe in TTY
 * and CI logs alike. Accepts an optional `write` function so tests can
 * capture output without touching stdout.
 */
export class ProgressUI {
  constructor(private readonly write: (s: string) => void = (s) => process.stdout.write(s)) {}

  /** Open a titled box section. */
  box(title: string): void {
    this.write(boxTop(title));
  }

  /**
   * Print a detection result line inside the current box.
   * @param label  - Short description (e.g. "TypeScript project")
   * @param detail - Optional parenthetical (e.g. "tsconfig.json found")
   * @param ok     - true = green ✓, false = dim ✗
   */
  detectionLine(label: string, detail: string = "", ok: boolean = true): void {
    const icon = ok ? `${GREEN}✓${RST}` : `${DIM}✗${RST}`;
    const detailPart = detail ? ` ${DIM}(${detail})${RST}` : "";
    this.write(boxLine(`${icon} ${label}${detailPart}`));
  }

  /**
   * Print a completed KB phase line inside the current box.
   * @param label - Phase description (e.g. "Scanning source files")
   * @param count - Number of entries produced
   * @param warn  - true = yellow ⚠ + "(failed)" instead of count
   */
  step(label: string, count: number, warn: boolean = false): void {
    const icon = warn ? `${YELLOW}⚠${RST}` : `${GREEN}◇${RST}`;
    const right = warn ? "(failed)" : `${count} ${count === 1 ? "entry" : "entries"}`;
    // Visible chars: 1 (icon) + 1 (space) + label + fill + right
    const fixedVis = 1 + 1 + label.length + 1 + right.length; // icon space label space right
    const fillLen = Math.max(1, BOX_INNER - 2 - fixedVis);
    const fill = fillLen > 1 ? ` ${"·".repeat(fillLen - 1)}` : " ";
    this.write(boxLine(`${icon} ${label}${fill}${right}`));
  }

  /** Close the current box section. */
  closeBox(): void {
    this.write(boxBottom());
  }

  /** Print the final summary after all phases complete. */
  summary(stats: KBStats, elapsedSec: number): void {
    this.write(
      `\n${GREEN}✨${RST} Done in ${elapsedSec}s.\n` +
      `Your AI agent now knows:\n` +
      `  • ${stats.conventions} conventions  ` +
      `• ${stats.decisions} decisions  ` +
      `• ${stats.errors} error patterns  ` +
      `• ${stats.learnings} learnings\n` +
      `\nNext: ${DIM}gyst dashboard${RST}  |  Open a new agent session — it'll feel different.\n\n`,
    );
  }
}
