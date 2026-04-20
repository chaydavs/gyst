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
  const dashes = BOX_WIDTH - 5 - visLen(title); // ╭─ {title} {dashes}╮
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
    // Visible chars: 1 (icon) + 1 (space) + label + right
    const fixedVis = 1 + 1 + label.length + right.length; // icon + space + label + right
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

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export interface AgentInfo {
  readonly name: string;
  readonly marker: string;
}

export interface DetectResult {
  readonly projectTypes: string[];
  readonly hasGit: boolean;
  readonly commitCount: number;
  readonly detectedAgents: AgentInfo[];
  readonly hasLlmKey: boolean;
}

/**
 * Scans the project directory and user home to determine project type,
 * git state, installed AI agents, and LLM key availability.
 *
 * Async because git commit count requires spawning git via simple-git.
 * All errors are caught internally — never throws.
 */
export async function detectEnvironment(projectDir: string): Promise<DetectResult> {
  // --- Project type ---
  const projectTypes: string[] = [];
  if (existsSync(join(projectDir, "tsconfig.json"))) {
    projectTypes.push("TypeScript");
  } else if (existsSync(join(projectDir, "package.json"))) {
    projectTypes.push("Node.js");
  }
  if (existsSync(join(projectDir, "Cargo.toml")))    projectTypes.push("Rust");
  if (existsSync(join(projectDir, "pyproject.toml")) ||
      existsSync(join(projectDir, "requirements.txt"))) projectTypes.push("Python");
  if (existsSync(join(projectDir, "go.mod")))         projectTypes.push("Go");
  if (existsSync(join(projectDir, "Gemfile")))        projectTypes.push("Ruby");
  if (projectTypes.length === 0) projectTypes.push("Unknown");

  // --- Git state ---
  let hasGit = false;
  let commitCount = 0;
  try {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit(projectDir);
    hasGit = await git.checkIsRepo().catch(() => false);
    if (hasGit) {
      try {
        const log = await git.log();
        commitCount = log.total;
      } catch {
        // empty repo — hasGit stays true, commitCount stays 0
      }
    }
  } catch {
    hasGit = false;
    commitCount = 0;
  }

  // --- Agent detection ---
  const home = homedir();
  const agentChecks: Array<{ name: string; marker: string; path: string }> = [
    { name: "Claude Code", marker: ".mcp.json",            path: join(projectDir, ".mcp.json") },
    { name: "Cursor",      marker: ".cursor/",             path: join(projectDir, ".cursor") },
    { name: "Gemini CLI",  marker: "~/.gemini/",           path: join(home, ".gemini") },
    { name: "Windsurf",    marker: "~/.codeium/windsurf/", path: join(home, ".codeium", "windsurf") },
    { name: "Codex CLI",   marker: "~/.codex/",            path: join(home, ".codex") },
  ];
  const detectedAgents: AgentInfo[] = agentChecks
    .filter((a) => existsSync(a.path))
    .map(({ name, marker }) => ({ name, marker }));

  // --- LLM key ---
  const hasLlmKey = !!process.env["ANTHROPIC_API_KEY"];

  return { projectTypes, hasGit, commitCount, detectedAgents, hasLlmKey };
}
