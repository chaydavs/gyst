/**
 * Adaptive formatting helpers for recall tool responses.
 *
 * Self-hosted LLMs have much smaller context windows than Claude Code
 * or Cursor. This module exposes format functions at four tiers so the
 * recall tool can degrade gracefully when the caller specifies a tight
 * context budget.
 *
 * Tiers:
 *   full         — 5000+ tokens: full entries with title, body, evidence
 *   compact      — 2000–4999  : top 3 entries, title + first 2 sentences
 *   minimal      —  800–1999  : top 2 entries, title + one-line summary
 *   ultraMinimal — < 800      : top 1 entry, title + first sentence only
 */

import { truncateToTokenBudget } from "./tokens.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape consumed by the formatters — matches the rows returned by recall's fetchEntries. */
export interface FormattableEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly files?: readonly string[];
  readonly tags?: readonly string[];
}

// ---------------------------------------------------------------------------
// Sentence splitting helper
// ---------------------------------------------------------------------------

/**
 * Splits text into sentences on .!? boundaries followed by whitespace.
 *
 * @param text - Input text to split.
 * @returns Array of sentence strings.
 */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/**
 * Extracts a "Fix:" line from error_pattern content if present.
 *
 * @param content - Entry content to search.
 * @returns The fix line text, or undefined if not found.
 */
function extractFixLine(content: string): string | undefined {
  const match = /\bfix[:\s]/i.exec(content);
  if (match === null) {
    return undefined;
  }
  // Extract from "Fix:" to end of sentence or end of string
  const afterFix = content.slice(match.index);
  const sentences = splitSentences(afterFix);
  return sentences[0] !== undefined ? sentences[0].trim() : undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Chooses a formatter based on the caller's token budget and applies it.
 *
 * @param entries - Ranked entries to format (already filtered and sorted).
 * @param budget  - Maximum tokens allowed in the formatted output.
 * @returns Markdown-formatted string that fits within budget tokens.
 */
export function formatForContext(
  entries: readonly FormattableEntry[],
  budget: number,
): string {
  if (entries.length === 0) {
    return "No matching entries found.";
  }
  if (budget >= 5000) {
    return formatFull(entries.slice(0, 5), budget);
  }
  if (budget >= 2000) {
    return formatCompact(entries.slice(0, 3), budget);
  }
  if (budget >= 800) {
    return formatMinimal(entries.slice(0, 2), budget);
  }
  return formatUltraMinimal(entries[0]!, budget);
}

// ---------------------------------------------------------------------------
// Tier formatters
// ---------------------------------------------------------------------------

/**
 * Full format: title, type, confidence, full content, files, tags.
 *
 * Each entry is formatted as:
 *   ## [title] (type: X, confidence: 0.XX)
 *   [full content]
 *   Files: a, b, c
 *   Tags: x, y, z
 *   ---
 *
 * @param entries - Up to 5 entries to format.
 * @param budget  - Token budget for the entire output.
 * @returns Formatted markdown string within budget tokens.
 */
export function formatFull(
  entries: readonly FormattableEntry[],
  budget: number,
): string {
  const sections = entries.map((entry) => {
    const lines: string[] = [
      `## ${entry.title} (type: ${entry.type}, confidence: ${entry.confidence.toFixed(2)})`,
      entry.content,
    ];

    const files = entry.files;
    if (files !== undefined && files.length > 0) {
      lines.push(`Files: ${files.join(", ")}`);
    }

    const tags = entry.tags;
    if (tags !== undefined && tags.length > 0) {
      lines.push(`Tags: ${tags.join(", ")}`);
    }

    lines.push(`ref: gyst://entry/${entry.id}`);
    lines.push("---");
    return lines.join("\n");
  });

  const combined = sections.join("\n\n");
  return truncateToTokenBudget(combined, budget);
}

/**
 * Compact format: title + first 2 sentences + fix line (if error_pattern).
 *
 * Each entry is formatted as:
 *   ### [title] (0.XX)
 *   [first 2 sentences of content]
 *   Fix: [fix line only for error_pattern if present]
 *   ---
 *
 * @param entries - Up to 3 entries to format.
 * @param budget  - Token budget for the entire output.
 * @returns Formatted markdown string within budget tokens.
 */
export function formatCompact(
  entries: readonly FormattableEntry[],
  budget: number,
): string {
  const sections = entries.map((entry) => {
    const sentences = splitSentences(entry.content);
    const snippet = sentences.slice(0, 2).join(" ");

    const lines: string[] = [
      `### ${entry.title} (${entry.confidence.toFixed(2)})`,
      snippet,
    ];

    if (entry.type === "error_pattern") {
      const fixLine = extractFixLine(entry.content);
      if (fixLine !== undefined && !snippet.includes(fixLine)) {
        lines.push(fixLine);
      }
    }

    lines.push(`ref: gyst://entry/${entry.id}`);
    lines.push("---");
    return lines.join("\n");
  });

  const combined = sections.join("\n\n");
  return truncateToTokenBudget(combined, budget);
}

/**
 * Minimal format: title + one-line summary (first 80 chars of content).
 *
 * Each entry is formatted as:
 *   - [title]: [first 80 chars of content]
 *
 * @param entries - Up to 2 entries to format.
 * @param budget  - Token budget for the entire output.
 * @returns Formatted markdown string within budget tokens.
 */
export function formatMinimal(
  entries: readonly FormattableEntry[],
  budget: number,
): string {
  const lines = entries.map((entry) => {
    const snippet = entry.content.slice(0, 80).trimEnd();
    return `- ${entry.title}: ${snippet}`;
  });

  const combined = lines.join("\n");
  return truncateToTokenBudget(combined, budget);
}

/**
 * Ultra-minimal format: top 1 entry, title + first sentence.
 *
 * Output format:
 *   [title]
 *   [first sentence]
 *
 * @param entry  - Single entry to format.
 * @param budget - Token budget for the output.
 * @returns Formatted string within budget tokens.
 */
export function formatUltraMinimal(
  entry: FormattableEntry,
  budget: number,
): string {
  const sentences = splitSentences(entry.content);
  const firstSentence = sentences[0] ?? entry.content.slice(0, 100);
  const combined = `${entry.title}\n${firstSentence}`;
  return truncateToTokenBudget(combined, budget);
}
