/**
 * Style fingerprinting for the Gyst compiler layer.
 *
 * Detects the dominant coding style of a file or directory using regex
 * counting only — no AST parsing. Pure and side-effect-free.
 *
 * Used by the conventions pipeline to describe the ambient style of a
 * code base so that agents can generate suggestions that match what is
 * already in use.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StyleFingerprint {
  readonly indent: "tabs" | "spaces-2" | "spaces-4" | "mixed";
  readonly semicolons: "always" | "never" | "mixed";
  readonly quotes: "single" | "double" | "mixed";
  readonly trailingCommas: "always" | "never" | "mixed";
}

// ---------------------------------------------------------------------------
// Vote accumulators (mutable internally, never exposed)
// ---------------------------------------------------------------------------

interface IndentVotes {
  tabs: number;
  spaces2: number;
  spaces4: number;
}

interface SemicolonVotes {
  with: number;
  without: number;
}

interface QuoteVotes {
  single: number;
  double: number;
}

interface TrailingCommaVotes {
  with: number;
  without: number;
}

interface AllVotes {
  indent: IndentVotes;
  semicolons: SemicolonVotes;
  quotes: QuoteVotes;
  trailingCommas: TrailingCommaVotes;
}

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/** Matches a line that starts with at least one tab character. */
const TAB_INDENT = /^\t+/;

/** Matches a line that starts with exactly 2 spaces (not 4). */
const SPACES2_INDENT = /^ {2}(?! )/;

/** Matches a line that starts with exactly 4 spaces (not 8, etc.). */
const SPACES4_INDENT = /^ {4}(?! {4})/;

/**
 * Matches lines that are candidates for semicolon analysis.
 * Skips: blank lines, lines ending in `{`, `}`, `(`, `,`, pure-comment lines.
 * We strip inline comments before testing the final character.
 */
const SKIP_SEMICOLON_ENDINGS = /[{(,]$/;

/**
 * Matches a single-quoted string literal (not inside a template literal).
 * Uses a simple heuristic — counts `'...'` pairs excluding escaped quotes.
 */
const SINGLE_QUOTE_RE = /'(?:[^'\\]|\\.)*'/g;

/**
 * Matches a double-quoted string literal.
 * Uses a simple heuristic — counts `"..."` pairs excluding escaped quotes.
 */
const DOUBLE_QUOTE_RE = /"(?:[^"\\]|\\.)*"/g;

/**
 * Matches a closing `},` or `],` pattern indicating a trailing comma.
 * Must be at the end of the line (after optional whitespace).
 */
const TRAILING_COMMA_RE = /[}\]],\s*$/;

/**
 * Matches a closing `}` or `]` without a trailing comma.
 * Must be at the end of the line (after optional whitespace).
 * Note: `};` and `];` are NOT counted here — those are statement terminators
 * (e.g. `const x = {...};`) and carry no trailing-comma signal.
 */
const NO_TRAILING_COMMA_RE = /[}\]]\s*$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Applies the 70% majority threshold to a pair of vote counts.
 * Returns the winning option if one side has ≥70%, otherwise "mixed".
 *
 * @param a - Votes for the first option.
 * @param b - Votes for the second option.
 * @param labelA - Label for the first option.
 * @param labelB - Label for the second option.
 */
function applyThreshold<T extends string>(
  a: number,
  b: number,
  labelA: T,
  labelB: T,
  mixed: T,
): T {
  const total = a + b;
  if (total === 0) return mixed;
  if (a / total >= 0.7) return labelA;
  if (b / total >= 0.7) return labelB;
  return mixed;
}

/**
 * Resolves the indent winner from three competing buckets.
 * Tabs, 2-space, and 4-space are compared; the highest count wins
 * only if it holds ≥70% of the total indented-line votes.
 */
function resolveIndent(
  votes: IndentVotes,
): StyleFingerprint["indent"] {
  const total = votes.tabs + votes.spaces2 + votes.spaces4;
  if (total === 0) return "mixed";
  if (votes.tabs / total >= 0.7) return "tabs";
  if (votes.spaces2 / total >= 0.7) return "spaces-2";
  if (votes.spaces4 / total >= 0.7) return "spaces-4";
  return "mixed";
}

/**
 * Strips a trailing inline comment from a source line so we can reliably
 * test the last non-comment character.
 *
 * Handles `//` comments only (good enough for semicolon detection).
 * Does not attempt to handle block comments mid-line.
 */
function stripInlineComment(line: string): string {
  // Naively find `//` that is not inside a string.
  // For style detection purposes a simple split is accurate enough.
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  // Avoid stripping `//` inside a URL or string literal by checking
  // that the preceding character is not `:` (http://) and the character
  // is not inside balanced quotes — full accuracy not needed here.
  return line.slice(0, idx).trimEnd();
}

/**
 * Returns true for lines that should be skipped during semicolon analysis:
 * blank lines, lines that end in `{`, `}`, `(`, `,`, or are pure comments.
 */
function shouldSkipForSemicolon(stripped: string): boolean {
  if (stripped.length === 0) return true;
  if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) return true;
  if (SKIP_SEMICOLON_ENDINGS.test(stripped)) return true;
  // Also skip lines that end with `}` alone — they are block-close lines.
  if (/}$/.test(stripped)) return true;
  return false;
}

/**
 * Accumulates style votes from a single source file's content string.
 * Mutates `votes` in place — this is a private helper that never escapes
 * the module boundary.
 *
 * @param content - Raw file content.
 * @param votes   - Accumulator to update.
 */
function accumulateVotes(content: string, votes: AllVotes): void {
  const lines = content.split("\n");

  for (const rawLine of lines) {
    // -----------------------------------------------------------------------
    // Indent detection
    // -----------------------------------------------------------------------
    if (rawLine.length > 0 && (rawLine[0] === "\t" || rawLine[0] === " ")) {
      if (TAB_INDENT.test(rawLine)) {
        votes.indent.tabs++;
      } else if (SPACES4_INDENT.test(rawLine)) {
        // Test 4-space BEFORE 2-space so "    " (4) isn't misclassified as 2.
        votes.indent.spaces4++;
      } else if (SPACES2_INDENT.test(rawLine)) {
        votes.indent.spaces2++;
      }
    }

    // -----------------------------------------------------------------------
    // Semicolon detection
    // -----------------------------------------------------------------------
    const stripped = stripInlineComment(rawLine.trim());
    if (!shouldSkipForSemicolon(stripped)) {
      if (stripped.endsWith(";")) {
        votes.semicolons.with++;
      } else {
        // Line ends with a word char or closing paren/bracket — counts as
        // a statement that deliberately omits a semicolon.
        if (/[\w)'"`\]]$/.test(stripped)) {
          votes.semicolons.without++;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Trailing comma detection
    // -----------------------------------------------------------------------
    const trimmed = rawLine.trim();
    if (TRAILING_COMMA_RE.test(trimmed)) {
      votes.trailingCommas.with++;
    } else if (NO_TRAILING_COMMA_RE.test(trimmed)) {
      votes.trailingCommas.without++;
    }
  }

  // -------------------------------------------------------------------------
  // Quote detection — run on the whole file at once to handle multi-line
  // string contexts better.
  // -------------------------------------------------------------------------
  // Remove template literals before counting to avoid counting backtick
  // contents as single- or double-quoted strings.
  const noTemplates = content.replace(/`[^`]*`/g, "``");

  const singleMatches = noTemplates.match(SINGLE_QUOTE_RE);
  const doubleMatches = noTemplates.match(DOUBLE_QUOTE_RE);

  votes.quotes.single += singleMatches?.length ?? 0;
  votes.quotes.double += doubleMatches?.length ?? 0;
}

/**
 * Converts a fully accumulated votes object into a `StyleFingerprint`.
 */
function votesToFingerprint(votes: AllVotes): StyleFingerprint {
  return {
    indent: resolveIndent(votes.indent),
    semicolons: applyThreshold(
      votes.semicolons.with,
      votes.semicolons.without,
      "always",
      "never",
      "mixed",
    ),
    quotes: applyThreshold(
      votes.quotes.single,
      votes.quotes.double,
      "single",
      "double",
      "mixed",
    ),
    trailingCommas: applyThreshold(
      votes.trailingCommas.with,
      votes.trailingCommas.without,
      "always",
      "never",
      "mixed",
    ),
  };
}

/** Returns a zeroed votes object. */
function emptyVotes(): AllVotes {
  return {
    indent: { tabs: 0, spaces2: 0, spaces4: 0 },
    semicolons: { with: 0, without: 0 },
    quotes: { single: 0, double: 0 },
    trailingCommas: { with: 0, without: 0 },
  };
}

// ---------------------------------------------------------------------------
// Directory traversal
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * Recursively collects up to `limit` TypeScript/JavaScript file paths
 * starting at `dir`, skipping `node_modules`, `dist`, and `.git`.
 * Only descends one level of sub-directories (top-level + one deeper).
 *
 * @param dir   - Absolute path to the directory to scan.
 * @param limit - Maximum number of files to return.
 */
function collectSourceFiles(dir: string, limit: number): string[] {
  const results: string[] = [];

  function visit(current: string, depth: number): void {
    if (results.length >= limit) return;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (err) {
      logger.warn("style-fingerprint: cannot read directory", {
        dir: current,
        error: String(err),
      });
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;

      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (depth < 1) {
          visit(fullPath, depth + 1);
        }
      } else {
        const ext = entry.slice(entry.lastIndexOf("."));
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  visit(dir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fingerprints a single file's content string.
 *
 * Counts style signals across all lines and returns the dominant style for
 * each dimension. Returns "mixed" for any dimension where no style achieves
 * a ≥70% supermajority.
 *
 * This function is pure: it has no side effects and does not touch the
 * filesystem.
 *
 * @param content - Raw source file content as a string.
 * @returns A `StyleFingerprint` describing the dominant style.
 */
export function fingerprintFile(content: string): StyleFingerprint {
  const votes = emptyVotes();
  accumulateVotes(content, votes);
  const result = votesToFingerprint(votes);

  logger.debug("style-fingerprint: fingerprintFile complete", {
    indentVotes: votes.indent,
    semicolonVotes: votes.semicolons,
    quoteVotes: votes.quotes,
    trailingCommaVotes: votes.trailingCommas,
    result,
  });

  return result;
}

/**
 * Fingerprints a directory by sampling up to `limit` TypeScript/JavaScript
 * source files.
 *
 * Aggregates per-dimension vote counts across all sampled files and applies
 * the 70% majority threshold on the aggregate totals (not per-file). This
 * means a single very large file with a different style cannot easily skew
 * the result — vote counts reflect individual style signals, not file counts.
 *
 * Skips `node_modules`, `dist`, and `.git` directories. Descends at most one
 * level below the given directory.
 *
 * Returns all dimensions as "mixed" if the directory is empty or contains no
 * `.ts`/`.tsx`/`.js`/`.jsx` files.
 *
 * @param dir   - Absolute (or relative) path to the directory to fingerprint.
 * @param limit - Maximum number of files to sample (default 50).
 * @returns A `StyleFingerprint` describing the dominant style of the directory.
 */
export function fingerprintDirectory(
  dir: string,
  limit = 50,
): StyleFingerprint {
  const files = collectSourceFiles(dir, limit);

  logger.debug("style-fingerprint: fingerprintDirectory sampling", {
    dir,
    fileCount: files.length,
    limit,
  });

  if (files.length === 0) {
    logger.debug("style-fingerprint: no source files found, returning mixed", {
      dir,
    });
    return {
      indent: "mixed",
      semicolons: "mixed",
      quotes: "mixed",
      trailingCommas: "mixed",
    };
  }

  const votes = emptyVotes();

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      logger.warn("style-fingerprint: cannot read file, skipping", {
        file: filePath,
        error: String(err),
      });
      continue;
    }
    accumulateVotes(content, votes);
  }

  const result = votesToFingerprint(votes);

  logger.debug("style-fingerprint: fingerprintDirectory complete", {
    dir,
    filesScanned: files.length,
    result,
  });

  return result;
}
