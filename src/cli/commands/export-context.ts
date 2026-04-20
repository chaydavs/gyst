/**
 * export-context — generate context files for all detected AI agents.
 *
 * Queries the Gyst KB and produces agent-specific context files:
 *   - CLAUDE.md   (Claude Code) — wrapped in managed markers
 *   - .cursorrules (Cursor)
 *   - AGENTS.md   (Codex CLI)
 *   - .windsurfrules (Windsurf)
 *   - CONTEXT.md  (Gemini CLI / fallback)
 *
 * Files are idempotent: re-running replaces only the Gyst section.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextPayload {
  readonly ghostKnowledge: ReadonlyArray<{ id: string; title: string; content: string }>;
  readonly conventions: ReadonlyArray<{ id: string; title: string; content: string; confidence: number }>;
  readonly decisions: ReadonlyArray<{ id: string; title: string; content: string }>;
  readonly errorPatterns: ReadonlyArray<{ id: string; title: string; content: string }>;
}

export interface ExportContextOptions {
  readonly projectDir: string;
  readonly format?: string;
  readonly dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * Builds a ContextPayload by querying the knowledge base.
 * Applies a token-budget heuristic: if total chars exceed 16 000, content
 * is progressively truncated. Ghost knowledge is always kept in full.
 */
export function buildContextPayload(db: Database): ContextPayload {
  // Ghost knowledge — all active entries
  const ghostKnowledge = db
    .query<{ id: string; title: string; content: string }, []>(
      `SELECT id, title, content FROM entries
       WHERE type = 'ghost_knowledge' AND status = 'active'
       ORDER BY confidence DESC`,
    )
    .all();

  // Conventions — top 15 by confidence, threshold 0.4
  let conventions = db
    .query<{ id: string; title: string; content: string; confidence: number }, []>(
      `SELECT id, title, content, confidence FROM entries
       WHERE type = 'convention' AND status = 'active' AND confidence >= 0.4
       ORDER BY confidence DESC
       LIMIT 15`,
    )
    .all();

  // Decisions — last 10 by last_confirmed
  let decisions = db
    .query<{ id: string; title: string; content: string }, []>(
      `SELECT id, title, content FROM entries
       WHERE type = 'decision' AND status = 'active'
       ORDER BY last_confirmed DESC
       LIMIT 10`,
    )
    .all();

  // Error patterns — top 5 by source_count
  let errorPatterns = db
    .query<{ id: string; title: string; content: string }, []>(
      `SELECT e.id, e.title, e.content FROM entries e
       LEFT JOIN sources s ON s.entry_id = e.id
       WHERE e.type = 'error_pattern' AND e.status = 'active'
       GROUP BY e.id
       ORDER BY COUNT(s.id) DESC
       LIMIT 5`,
    )
    .all();

  // Token-budget heuristic
  const totalChars = (): number =>
    ghostKnowledge.reduce((a, e) => a + e.content.length, 0) +
    conventions.reduce((a, e) => a + e.content.length, 0) +
    decisions.reduce((a, e) => a + e.content.length, 0) +
    errorPatterns.reduce((a, e) => a + e.content.length, 0);

  if (totalChars() > 16_000) {
    // Step 1: truncate error_pattern content to 150 chars
    errorPatterns = errorPatterns.map((e) => ({ ...e, content: e.content.slice(0, 150) }));
  }
  if (totalChars() > 16_000) {
    // Step 2: reduce error_patterns to top 3
    errorPatterns = errorPatterns.slice(0, 3);
  }
  if (totalChars() > 16_000) {
    // Step 3: truncate convention content to 150 chars
    conventions = conventions.map((e) => ({ ...e, content: e.content.slice(0, 150) }));
  }
  if (totalChars() > 16_000) {
    // Step 4: reduce conventions to top 10
    conventions = conventions.slice(0, 10);
  }
  if (totalChars() > 16_000) {
    // Step 5: reduce decisions to top 5
    decisions = decisions.slice(0, 5);
  }

  return { ghostKnowledge, conventions, decisions, errorPatterns };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Section heading helpers used across multiple formatters */
function ghostSection(payload: ContextPayload): string {
  if (payload.ghostKnowledge.length === 0) return "";
  const lines: string[] = ["### ⚠️ Critical Rules\n"];
  for (const g of payload.ghostKnowledge) {
    lines.push(`**${g.title}**\n${g.content}\n`);
  }
  return lines.join("\n");
}

function errorSection(payload: ContextPayload): string {
  if (payload.errorPatterns.length === 0) return "";
  const lines: string[] = ["### 🐛 Known Error Patterns\n"];
  for (const e of payload.errorPatterns) {
    lines.push(`**${e.title}**\n${e.content}\n`);
  }
  return lines.join("\n");
}

function conventionSection(payload: ContextPayload): string {
  if (payload.conventions.length === 0) return "";
  const lines: string[] = ["### 📏 Conventions\n"];
  for (const c of payload.conventions) {
    const pct = Math.round(c.confidence * 100);
    lines.push(`**${c.title}** (${pct}% confidence)\n${c.content}\n`);
  }
  return lines.join("\n");
}

function decisionSection(payload: ContextPayload): string {
  if (payload.decisions.length === 0) return "";
  const lines: string[] = ["### 🏛️ Decisions\n"];
  for (const d of payload.decisions) {
    lines.push(`**${d.title}**\n${d.content}\n`);
  }
  return lines.join("\n");
}

/**
 * Produces the CLAUDE.md gyst section.
 * Wrapped in managed markers so the rest of the file is untouched.
 */
export function formatClaudeMd(payload: ContextPayload): string {
  const parts: string[] = [
    "## Gyst Team Knowledge\n",
    "_Auto-generated by [Gyst](https://github.com/gyst-dev/gyst). Do not edit this section manually._\n",
  ];

  const ghost = ghostSection(payload);
  if (ghost) parts.push(ghost);

  const errors = errorSection(payload);
  if (errors) parts.push(errors);

  const conventions = conventionSection(payload);
  if (conventions) parts.push(conventions);

  const decisions = decisionSection(payload);
  if (decisions) parts.push(decisions);

  if (parts.length === 2) {
    parts.push("_No entries found. Run `gyst init` to bootstrap your knowledge base._\n");
  }

  return parts.join("\n");
}

/**
 * Produces an AGENTS.md context file (Codex CLI format).
 * Sections: ## Rules, ## Conventions, ## Architecture
 */
export function formatAgentsMd(payload: ContextPayload): string {
  const sections: string[] = [
    "# Gyst — Team Knowledge Context\n",
    "_Auto-generated by Gyst. Re-run `gyst export-context` to refresh._\n",
  ];

  // Rules section = ghost + errors
  const ruleLines: string[] = [];
  for (const g of payload.ghostKnowledge) {
    ruleLines.push(`- ⚠️ **${g.title}**: ${g.content}`);
  }
  for (const e of payload.errorPatterns) {
    ruleLines.push(`- 🐛 **${e.title}**: ${e.content}`);
  }
  if (ruleLines.length > 0) {
    sections.push("## Rules\n\n" + ruleLines.join("\n") + "\n");
  }

  // Conventions section
  if (payload.conventions.length > 0) {
    const lines = payload.conventions.map(
      (c) => `- 📏 **${c.title}** (${Math.round(c.confidence * 100)}%): ${c.content}`,
    );
    sections.push("## Conventions\n\n" + lines.join("\n") + "\n");
  }

  // Architecture section = decisions
  if (payload.decisions.length > 0) {
    const lines = payload.decisions.map((d) => `- 🏛️ **${d.title}**: ${d.content}`);
    sections.push("## Architecture\n\n" + lines.join("\n") + "\n");
  }

  return sections.join("\n");
}

/**
 * Produces a .cursorrules file (instructional header + sections).
 */
export function formatCursorRules(payload: ContextPayload): string {
  const parts: string[] = [
    "# Cursor Rules — Gyst Team Knowledge\n",
    "# Auto-generated by Gyst. Re-run `gyst export-context` to refresh.\n",
    "# This file contains team-agreed rules, conventions and architecture decisions.\n",
  ];

  const ghost = ghostSection(payload);
  if (ghost) parts.push(ghost);

  const errors = errorSection(payload);
  if (errors) parts.push(errors);

  const conventions = conventionSection(payload);
  if (conventions) parts.push(conventions);

  const decisions = decisionSection(payload);
  if (decisions) parts.push(decisions);

  if (parts.length === 3) {
    parts.push("# No entries found. Run `gyst init` to bootstrap your knowledge base.\n");
  }

  return parts.join("\n");
}

/**
 * Produces a generic CONTEXT.md fallback file.
 */
export function formatGeneric(payload: ContextPayload): string {
  const parts: string[] = [
    "# Gyst — Team Knowledge Context\n",
    "_Auto-generated by Gyst. Re-run `gyst export-context` to refresh._\n",
  ];

  const ghost = ghostSection(payload);
  if (ghost) parts.push(ghost);

  const errors = errorSection(payload);
  if (errors) parts.push(errors);

  const conventions = conventionSection(payload);
  if (conventions) parts.push(conventions);

  const decisions = decisionSection(payload);
  if (decisions) parts.push(decisions);

  if (parts.length === 2) {
    parts.push("_No entries found. Run `gyst init` to bootstrap your knowledge base._\n");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// File writer (with marker support)
// ---------------------------------------------------------------------------

const BEGIN_MARKER = "<!-- BEGIN GYST CONTEXT -->";
const END_MARKER   = "<!-- END GYST CONTEXT -->";

/**
 * Writes `content` to `filePath`.
 *
 * When `markers` are provided:
 *  - If the file exists and contains both markers, the section between them
 *    is replaced (content outside the markers is preserved).
 *  - If the file exists but lacks the markers, the marked section is appended.
 *  - If the file does not exist, it is created with the marked section.
 *
 * Without markers the file is simply written (or overwritten).
 */
export function writeContextFile(
  filePath: string,
  content: string,
  markers?: { begin: string; end: string },
): void {
  mkdirSync(dirname(filePath), { recursive: true });

  if (!markers) {
    writeFileSync(filePath, content, "utf-8");
    return;
  }

  const { begin, end } = markers;
  const markedBlock = `${begin}\n${content}\n${end}\n`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, markedBlock, "utf-8");
    return;
  }

  const existing = readFileSync(filePath, "utf-8");
  const beginIdx = existing.indexOf(begin);
  const endIdx   = existing.indexOf(end);

  if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
    // Replace content between markers (inclusive of markers)
    const before = existing.slice(0, beginIdx);
    const after  = existing.slice(endIdx + end.length).trimStart();
    // Ensure a newline between before content and markers
    const separator = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
    writeFileSync(filePath, `${before}${separator}${markedBlock}${after}`, "utf-8");
  } else {
    // Markers not found — append at end
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(filePath, `${existing}${separator}\n${markedBlock}`, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Agent → file mapping
// ---------------------------------------------------------------------------

interface AgentFileSpec {
  readonly filePath: string;
  readonly formatter: (p: ContextPayload) => string;
  readonly markers?: { begin: string; end: string };
}

function buildAgentFileSpecs(projectDir: string, detectedAgents: string[]): AgentFileSpec[] {
  const specs: AgentFileSpec[] = [];
  const seen = new Set<string>();

  for (const agentName of detectedAgents) {
    switch (agentName) {
      case "Claude Code":
        specs.push({
          filePath: join(projectDir, "CLAUDE.md"),
          formatter: formatClaudeMd,
          markers: { begin: BEGIN_MARKER, end: END_MARKER },
        });
        seen.add("CLAUDE.md");
        break;

      case "Cursor":
        specs.push({
          filePath: join(projectDir, ".cursorrules"),
          formatter: formatCursorRules,
        });
        seen.add(".cursorrules");
        break;

      case "Codex CLI":
        specs.push({
          filePath: join(projectDir, "AGENTS.md"),
          formatter: formatAgentsMd,
        });
        seen.add("AGENTS.md");
        break;

      case "Windsurf":
        specs.push({
          filePath: join(projectDir, ".windsurfrules"),
          formatter: formatCursorRules, // same instructional format
        });
        seen.add(".windsurfrules");
        break;

      case "Gemini CLI":
        specs.push({
          filePath: join(projectDir, "CONTEXT.md"),
          formatter: formatGeneric,
        });
        seen.add("CONTEXT.md");
        break;
    }
  }

  // Fallback: no agent matched → write CONTEXT.md
  if (specs.length === 0) {
    specs.push({
      filePath: join(projectDir, "CONTEXT.md"),
      formatter: formatGeneric,
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates context files for a list of detected agent names.
 *
 * @param db            - Open database connection.
 * @param projectDir    - Project root directory.
 * @param detectedAgents - Agent names (matching installer.ts TOOL_DESCRIPTORS names).
 * @returns List of absolute file paths that were written.
 */
export function generateContextFiles(
  db: Database,
  projectDir: string,
  detectedAgents: string[],
): string[] {
  const payload = buildContextPayload(db);
  const specs   = buildAgentFileSpecs(projectDir, detectedAgents);
  const written: string[] = [];

  for (const spec of specs) {
    const content = spec.formatter(payload);
    writeContextFile(spec.filePath, content, spec.markers);
    written.push(spec.filePath);
  }

  return written;
}

/**
 * CLI action for `gyst export-context`.
 *
 * Auto-detects agents when format is omitted or "auto", then writes the
 * appropriate context files. In dry-run mode prints to stdout instead.
 */
export async function runExportContext(opts: ExportContextOptions): Promise<void> {
  const { loadConfig } = await import("../../utils/config.js");
  const { initDatabase } = await import("../../store/database.js");

  const config = loadConfig(opts.projectDir);
  const db = initDatabase(config.dbPath);

  try {
    const payload = buildContextPayload(db);

    if (opts.dryRun) {
      // Print requested format(s) to stdout
      const formats = resolveFormats(opts.format);
      for (const fmt of formats) {
        const content = applyFormat(fmt, payload);
        process.stdout.write(`\n--- ${fmt} ---\n`);
        process.stdout.write(content);
        process.stdout.write("\n");
      }
      return;
    }

    if (opts.format && opts.format !== "auto") {
      // Write a single explicit format
      const specs = resolveExplicitFormat(opts.format, opts.projectDir);
      for (const spec of specs) {
        const content = spec.formatter(payload);
        writeContextFile(spec.filePath, content, spec.markers);
        process.stdout.write(`  wrote ${spec.filePath}\n`);
      }
      return;
    }

    // Auto-detect agents
    const { detectEnvironment } = await import("./init.js");
    const env = await detectEnvironment(opts.projectDir);
    const agentNames = env.detectedAgents.map((a) => a.name);

    const written = generateContextFiles(db, opts.projectDir, agentNames);
    if (written.length === 0) {
      process.stdout.write("No context files generated (no AI agents detected).\n");
      process.stdout.write("Tip: use --format <claude|codex|cursor|windsurf|gemini|generic> to write a specific file.\n");
    } else {
      for (const f of written) {
        process.stdout.write(`  wrote ${f}\n`);
      }
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for explicit --format handling
// ---------------------------------------------------------------------------

function resolveFormats(format: string | undefined): string[] {
  if (!format || format === "auto") {
    return ["claude", "codex", "cursor", "windsurf", "gemini", "generic"];
  }
  if (format === "all") {
    return ["claude", "codex", "cursor", "windsurf", "gemini"];
  }
  return [format];
}

function applyFormat(format: string, payload: ContextPayload): string {
  switch (format) {
    case "claude":   return formatClaudeMd(payload);
    case "codex":    return formatAgentsMd(payload);
    case "cursor":   return formatCursorRules(payload);
    case "windsurf": return formatCursorRules(payload);
    case "gemini":   return formatGeneric(payload);
    default:         return formatGeneric(payload);
  }
}

function resolveExplicitFormat(format: string, projectDir: string): AgentFileSpec[] {
  switch (format) {
    case "claude":
      return [{
        filePath: join(projectDir, "CLAUDE.md"),
        formatter: formatClaudeMd,
        markers: { begin: BEGIN_MARKER, end: END_MARKER },
      }];
    case "codex":
      return [{
        filePath: join(projectDir, "AGENTS.md"),
        formatter: formatAgentsMd,
      }];
    case "cursor":
      return [{
        filePath: join(projectDir, ".cursorrules"),
        formatter: formatCursorRules,
      }];
    case "windsurf":
      return [{
        filePath: join(projectDir, ".windsurfrules"),
        formatter: formatCursorRules,
      }];
    case "gemini":
      return [{
        filePath: join(projectDir, "CONTEXT.md"),
        formatter: formatGeneric,
      }];
    case "generic":
      return [{
        filePath: join(projectDir, "CONTEXT.md"),
        formatter: formatGeneric,
      }];
    case "all":
      return [
        { filePath: join(projectDir, "CLAUDE.md"),       formatter: formatClaudeMd,   markers: { begin: BEGIN_MARKER, end: END_MARKER } },
        { filePath: join(projectDir, "AGENTS.md"),       formatter: formatAgentsMd },
        { filePath: join(projectDir, ".cursorrules"),    formatter: formatCursorRules },
        { filePath: join(projectDir, ".windsurfrules"),  formatter: formatCursorRules },
        { filePath: join(projectDir, "CONTEXT.md"),      formatter: formatGeneric },
      ];
    default:
      return [{
        filePath: join(projectDir, "CONTEXT.md"),
        formatter: formatGeneric,
      }];
  }
}
