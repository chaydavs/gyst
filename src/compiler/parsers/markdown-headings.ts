/**
 * Parses long-form planning/PRD markdown docs into structured form.
 *
 * Gyst plan convention (see docs/superpowers/plans/*.md):
 *   Line 1: `# <plan title>`
 *   Labeled paragraphs: `**Goal:** ...`, `**Architecture:** ...`, `**Tech Stack:** ...`
 *   Sections: `## File Structure`, `## Phases`, etc.
 *   Task checkboxes: `- [ ] <task>` or `- [x] <done>`
 *
 * The parser emits a structural outline that downstream classification can
 * turn into `learning` entries — one per plan document. Checkbox totals let
 * the distiller report plan progress as a separate signal.
 */
import { logger } from "../../utils/logger.js";

export interface ParsedPlan {
  readonly title: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly sections: ReadonlyArray<{ heading: string; level: number; preview: string }>;
  readonly tasks: { total: number; done: number; open: number };
  readonly summary: string;
}

const LABEL_REGEX = /^\*\*([A-Z][\w\s-]*?)\s*:\*\*\s*(.*)$/;

/**
 * Parses a plan / PRD / design-doc markdown into a structural summary.
 * Returns null when no top-level `#` heading is present.
 */
export function parsePlanDoc(markdown: string): ParsedPlan | null {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0) return null;

  let title = "";
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim();
      break;
    }
  }
  if (title.length === 0) {
    logger.debug("parsePlanDoc: no top-level heading");
    return null;
  }

  // Labeled paragraphs: capture `**Label:** value` lines between the title
  // and the first `## ` section.
  const labels: Record<string, string> = {};
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith("## ")) break;
    const m = trimmed.match(LABEL_REGEX);
    if (m) {
      const label = m[1].trim();
      const value = m[2].trim();
      if (value.length > 0) labels[label] = value;
    }
  }

  // Sections: `## <heading>` and `### <heading>` with preview of first
  // non-empty line for context.
  const sections: { heading: string; level: number; preview: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const heading = m[2].trim();
    let preview = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      const lx = lines[j].trim();
      if (lx.startsWith("#")) break;
      if (lx.length > 0) {
        preview = lx.slice(0, 200);
        break;
      }
    }
    sections.push({ heading, level, preview });
  }

  // Task checkboxes — count open vs done.
  let total = 0;
  let done = 0;
  for (const l of lines) {
    const m = l.match(/^\s*-\s*\[([ xX])\]/);
    if (!m) continue;
    total += 1;
    if (m[1].toLowerCase() === "x") done += 1;
  }

  const goal = labels["Goal"] ?? labels["Summary"] ?? "";
  const summaryParts = [
    goal.length > 0 ? `Goal: ${goal}` : null,
    sections.length > 0 ? `${sections.length} sections` : null,
    total > 0 ? `${done}/${total} tasks done` : null,
  ].filter((p): p is string => p !== null);

  const summary =
    summaryParts.length > 0
      ? summaryParts.join(" · ")
      : truncate(lines.join(" ").replace(/^#.*$/m, ""), 200);

  return {
    title,
    labels,
    sections,
    tasks: { total, done, open: total - done },
    summary,
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
