/**
 * Parses Architecture Decision Records from `decisions/NNN-<slug>.md`.
 *
 * Gyst's ADR convention (see decisions/001-query-expansion.md):
 *   Line 1: `# Decision: <title>` (or `# <title>` for older ADRs)
 *   Preamble: `Date: YYYY-MM-DD` and `Status: <status>` on separate lines
 *   Sections: `## Context`, `## Options`, `## Decision`, `## Outcome`, etc.
 *
 * The parser is tolerant: preamble order is flexible, sections are optional,
 * and an ADR missing both date and status still yields a valid parse result
 * — downstream classification decides whether to promote it.
 */
import { logger } from "../../utils/logger.js";

export interface ParsedAdr {
  readonly number: number | null;
  readonly title: string;
  readonly status: string | null;
  readonly date: string | null;
  readonly sections: Readonly<Record<string, string>>;
  readonly summary: string;
}

const ADR_FILENAME_REGEX = /(?:^|\/)(\d{3,4})-([\w-]+)\.md$/;

/**
 * Parses a single ADR file's raw markdown + its filename.
 * Returns null when the input has no title and no detectable structure.
 */
export function parseAdr(filename: string, markdown: string): ParsedAdr | null {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0) return null;

  // Title: first non-blank line starting with `#`. Strip `Decision:` prefix.
  let titleLine = "";
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("# ")) {
      titleLine = trimmed.slice(2).trim();
      break;
    }
  }
  if (titleLine.length === 0) {
    logger.debug("parseAdr: no top-level heading found", { filename });
    return null;
  }
  const title = titleLine.replace(/^Decision\s*:\s*/i, "").trim();

  // ADR number from filename — e.g. decisions/042-fix-x.md → 42.
  const numMatch = filename.match(ADR_FILENAME_REGEX);
  const number = numMatch ? parseInt(numMatch[1], 10) : null;

  // Preamble: scan for `Date:` and `Status:` lines between title and first `##`.
  let status: string | null = null;
  let date: string | null = null;
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("## ")) break;
    const dateMatch = trimmed.match(/^Date\s*:\s*(.+)$/i);
    if (dateMatch) date = dateMatch[1].trim();
    const statusMatch = trimmed.match(/^Status\s*:\s*(.+)$/i);
    if (statusMatch) status = statusMatch[1].trim();
  }

  // Sections: split on `## ` headings, capture body until the next `## `.
  const sections: Record<string, string> = {};
  let currentHeading: string | null = null;
  let currentBuffer: string[] = [];
  for (const l of lines) {
    const h = l.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (currentHeading) sections[currentHeading] = currentBuffer.join("\n").trim();
      currentHeading = h[1].trim();
      currentBuffer = [];
      continue;
    }
    if (currentHeading) currentBuffer.push(l);
  }
  if (currentHeading) sections[currentHeading] = currentBuffer.join("\n").trim();

  // Summary: prefer "Decision" section, fall back to "Context", else first 400 chars of body.
  const body = lines.join("\n");
  const preferred = pickSection(sections, ["Decision", "Change", "Context"]);
  const summary = preferred
    ? truncate(preferred, 1200)
    : truncate(body.replace(/^#.*$/m, "").trim(), 400);

  return { number, title, status, date, sections, summary };
}

function pickSection(
  sections: Record<string, string>,
  preferences: readonly string[],
): string | null {
  for (const name of preferences) {
    const key = Object.keys(sections).find(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    if (key && sections[key].length > 0) return sections[key];
  }
  return null;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
