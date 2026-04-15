/**
 * Session-start context injection for Gyst.
 *
 * Generates a compact markdown block surfacing ghost_knowledge rules,
 * top conventions, and the most recent error pattern from the team knowledge
 * base. Intended to be injected at session start so agents immediately know
 * team constraints without needing to call recall first.
 */

import type { Database } from "bun:sqlite";
import { truncateToTokenBudget } from "../utils/tokens.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SessionContextOptions {
  readonly db: Database;
  readonly projectDir: string;
  readonly maxTokens?: number; // default 500
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface GhostKnowledgeRow {
  title: string;
  content: string;
}

interface ConventionRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
}

interface ErrorPatternRow {
  title: string;
  confidence: number;
}

interface TopFileRow {
  file_path: string;
  entry_count: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const GHOST_KNOWLEDGE_SQL = `
  SELECT title, content FROM entries
  WHERE type = 'ghost_knowledge' AND status = 'active'
  ORDER BY created_at DESC
`;

const CONVENTIONS_SQL = `
  SELECT DISTINCT e.id, e.title, e.content, e.confidence
  FROM entries e
  LEFT JOIN entry_files ef ON ef.entry_id = e.id
  WHERE e.type = 'convention' AND e.status = 'active'
    AND (ef.file_path LIKE ? OR ef.file_path IS NULL)
  ORDER BY e.confidence DESC
  LIMIT 3
`;

const ERROR_PATTERN_SQL = `
  SELECT title, confidence FROM entries
  WHERE type = 'error_pattern' AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 1
`;

const TOP_FILES_SQL = `
  SELECT file_path, COUNT(*) as entry_count
  FROM entry_files
  GROUP BY file_path
  ORDER BY entry_count DESC
  LIMIT 10
`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Generates a compact session-start context block from the team knowledge base.
 * Surfaces: ghost_knowledge rules, top conventions for this project dir,
 * and the most recent error pattern.
 *
 * Designed to be injected at session start (e.g., via a SessionStart hook)
 * so agents immediately know team constraints without calling recall first.
 *
 * @param opts - Options including the database connection, project directory,
 *               and optional token budget (default 500).
 * @returns Markdown-formatted context string, or empty string if no data found.
 */
export function generateSessionContext(opts: SessionContextOptions): string {
  const { db, projectDir, maxTokens = 500 } = opts;

  const ghostRows = db
    .query<GhostKnowledgeRow, []>(GHOST_KNOWLEDGE_SQL)
    .all();

  const conventionRows = db
    .query<ConventionRow, [string]>(CONVENTIONS_SQL)
    .all(`${projectDir}%`);

  const errorRows = db
    .query<ErrorPatternRow, []>(ERROR_PATTERN_SQL)
    .all();

  const topFileRows = db
    .query<TopFileRow, []>(TOP_FILES_SQL)
    .all();

  // Return empty string if all queries came back empty.
  if (ghostRows.length === 0 && conventionRows.length === 0 && errorRows.length === 0 && topFileRows.length === 0) {
    return "";
  }

  const sections: string[] = ["# Gyst Context"];

  if (topFileRows.length > 0) {
    const lines = topFileRows.map((r) => `- ${r.file_path}`).join("\n");
    sections.push(`## Already Indexed Files (Do NOT re-read)\n${lines}`);
  }

  if (ghostRows.length > 0) {
    const lines = ghostRows.map((r) => `- ${r.title}`).join("\n");
    sections.push(`## Team Rules\n${lines}`);
  }

  if (conventionRows.length > 0) {
    const lines = conventionRows.map((r) => `- ${r.title}`).join("\n");
    sections.push(`## Conventions (${projectDir})\n${lines}`);
  }

  if (errorRows.length > 0) {
    const r = errorRows[0];
    sections.push(`## Recent Error Pattern\n- ${r.title} (confidence: ${r.confidence.toFixed(2)})`);
  }

  const text = sections.join("\n");
  return truncateToTokenBudget(text, maxTokens);
}
