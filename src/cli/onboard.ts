/**
 * Onboarding document generator for Gyst.
 *
 * Reads the live knowledge base and produces a structured markdown document
 * that new team members (or AI agents) can use to get up to speed fast.
 *
 * The output is a pure string — callers are responsible for writing it to
 * disk or stdout. No side effects beyond DB reads.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options accepted by generateOnboarding(). */
export interface OnboardingOptions {
  /** Absolute path to the project root directory. */
  readonly dir: string;
  /** Output format. Only "markdown" is supported (default). */
  readonly format?: "markdown";
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface GhostRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

interface ConventionRow {
  readonly id: string;
  readonly title: string;
  readonly confidence: number;
  readonly tags: string | null;
}

interface DecisionRow {
  readonly title: string;
  readonly created_at: string;
}

interface ErrorPatternRow {
  readonly title: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Package.json shape (only the fields we care about)
// ---------------------------------------------------------------------------

interface PackageScripts {
  readonly install?: string;
  readonly dev?: string;
  readonly test?: string;
  readonly build?: string;
  [key: string]: string | undefined;
}

interface PackageJson {
  readonly name?: string;
  readonly scripts?: PackageScripts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first sentence of `text` (up to the first `.` or `\n`),
 * truncated to 120 characters. Never mutates the input.
 */
function firstSentence(text: string): string {
  const end = text.search(/[.\n]/);
  const sentence = end === -1 ? text : text.slice(0, end);
  return sentence.trim().slice(0, 120);
}

/**
 * Converts a category slug to title-case display text.
 * e.g. "error_handling" → "Error handling"
 */
function titleCase(category: string): string {
  const spaced = category.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Extracts the `category:*` value from a comma-separated tags string.
 * Returns "other" when no category tag is present.
 */
function extractCategory(tags: string | null): string {
  if (tags === null) return "other";
  const found = tags.split(",").find((t) => t.startsWith("category:"));
  if (found === undefined) return "other";
  return found.slice("category:".length);
}

/**
 * Attempts to read and parse `package.json` from `dir`.
 * Returns null on any failure so callers can fall back gracefully.
 */
function readPackageJson(dir: string): PackageJson | null {
  try {
    const raw = readFileSync(join(dir, "package.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PackageJson;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Section builders — each returns a string[] of lines
// ---------------------------------------------------------------------------

/** Section 1: document header with project name and generation date. */
function buildHeader(dir: string): string[] {
  const pkg = readPackageJson(dir);
  const projectName =
    typeof pkg?.name === "string" && pkg.name.length > 0
      ? pkg.name
      : basename(dir);

  const date = new Date().toISOString().slice(0, 10);

  return [
    `# Onboarding: ${projectName}`,
    "",
    `Generated ${date} by gyst onboard.`,
  ];
}

/** Section 2: ghost_knowledge entries shown as inviolable team rules. */
function buildTeamRules(db: Database): string[] {
  const rows = db
    .query<GhostRow, []>(
      `SELECT id, title, content FROM entries
       WHERE type = 'ghost_knowledge' AND status = 'active'
       ORDER BY created_at DESC`,
    )
    .all();

  const lines: string[] = ["", "## Team Rules (inviolable)", ""];

  if (rows.length === 0) {
    lines.push("_(No team rules defined yet.)_");
    return lines;
  }

  for (const row of rows) {
    lines.push(`- **${row.title}** — ${firstSentence(row.content)}`);
  }

  return lines;
}

/** Section 3: conventions grouped by category tag. */
function buildConventions(db: Database): string[] {
  const rows = db
    .query<ConventionRow, []>(
      `SELECT e.id, e.title, e.confidence,
              GROUP_CONCAT(et.tag, ',') AS tags
       FROM entries e
       LEFT JOIN entry_tags et ON et.entry_id = e.id
       WHERE e.type = 'convention' AND e.status = 'active'
       GROUP BY e.id
       ORDER BY e.confidence DESC`,
    )
    .all();

  const lines: string[] = ["", "## Conventions", ""];

  if (rows.length === 0) {
    lines.push(
      "_(No conventions detected yet. Run `gyst detect-conventions` to auto-detect them.)_",
    );
    return lines;
  }

  // Group by category
  const grouped = new Map<string, ConventionRow[]>();
  for (const row of rows) {
    const cat = extractCategory(row.tags);
    const existing = grouped.get(cat);
    if (existing !== undefined) {
      grouped.set(cat, [...existing, row]);
    } else {
      grouped.set(cat, [row]);
    }
  }

  const CATEGORY_ORDER: readonly string[] = [
    "naming",
    "imports",
    "imports_order",
    "error_handling",
    "custom_errors",
    "exports",
    "testing",
    "file_naming",
    "other",
  ];

  // Ordered categories that have entries, followed by any unlisted categories
  const orderedCategories: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    if (grouped.has(cat)) orderedCategories.push(cat);
  }
  for (const cat of grouped.keys()) {
    if (!CATEGORY_ORDER.includes(cat)) orderedCategories.push(cat);
  }

  for (const cat of orderedCategories) {
    const entries = grouped.get(cat);
    if (entries === undefined || entries.length === 0) continue;

    lines.push(`### ${titleCase(cat)}`);
    for (const entry of entries) {
      lines.push(`- ${entry.title} (confidence: ${entry.confidence.toFixed(2)})`);
    }
    lines.push("");
  }

  // Remove trailing blank line added after last category
  if (lines[lines.length - 1] === "") lines.pop();

  return lines;
}

/** Section 4: five most recent decision entries. */
function buildRecentDecisions(db: Database): string[] {
  const rows = db
    .query<DecisionRow, []>(
      `SELECT title, created_at FROM entries
       WHERE type = 'decision' AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 5`,
    )
    .all();

  const lines: string[] = ["", "## Recent Decisions", ""];

  if (rows.length === 0) {
    lines.push("_(No decisions recorded yet.)_");
    return lines;
  }

  for (const row of rows) {
    lines.push(`- ${row.title} (${row.created_at.slice(0, 10)})`);
  }

  return lines;
}

/** Section 5: five most recent error patterns to avoid. */
function buildErrorPatterns(db: Database): string[] {
  const rows = db
    .query<ErrorPatternRow, []>(
      `SELECT title, content FROM entries
       WHERE type = 'error_pattern' AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 5`,
    )
    .all();

  const lines: string[] = ["", "## Error Patterns to Avoid", ""];

  if (rows.length === 0) {
    lines.push("_(No error patterns recorded yet.)_");
    return lines;
  }

  for (const row of rows) {
    lines.push(`- **${row.title}** — ${firstSentence(row.content)}`);
  }

  return lines;
}

/** Section 6: getting-started commands derived from package.json scripts. */
function buildGettingStarted(dir: string): string[] {
  const pkg = readPackageJson(dir);
  const scripts = pkg?.scripts ?? {};

  const installCmd = typeof scripts["install"] === "string" ? scripts["install"] : "bun install";
  const devCmd = typeof scripts["dev"] === "string" ? scripts["dev"] : "bun run dev";
  const testCmd = typeof scripts["test"] === "string" ? scripts["test"] : "bun test";
  const buildCmd = typeof scripts["build"] === "string" ? scripts["build"] : "bun run build";

  return [
    "",
    "## Getting Started",
    "",
    `- Install: \`${installCmd}\``,
    `- Dev: \`${devCmd}\``,
    `- Test: \`${testCmd}\``,
    `- Build: \`${buildCmd}\``,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates an onboarding markdown document from the live knowledge base.
 *
 * Reads ghost_knowledge, conventions, decisions, and error_pattern entries
 * from `db` and assembles them into a structured markdown string. All DB
 * queries are synchronous (bun:sqlite). No entries are written.
 *
 * @param db   - An open bun:sqlite Database instance.
 * @param opts - Generation options (project dir, output format).
 * @returns    A complete markdown string ready to write or print.
 */
export function generateOnboarding(db: Database, opts: OnboardingOptions): string {
  const lines: string[] = [
    ...buildHeader(opts.dir),
    ...buildTeamRules(db),
    ...buildConventions(db),
    ...buildRecentDecisions(db),
    ...buildErrorPatterns(db),
    ...buildGettingStarted(opts.dir),
    "",
  ];

  return lines.join("\n");
}
