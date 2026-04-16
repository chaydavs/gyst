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
  readonly developerId?: string;
  readonly globalDb?: Database;
}

export interface SessionContextResult {
  readonly agentContext: string;
  readonly userSummary: string;
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

interface PersonalEntryRow {
  title: string;
  type: string;
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

const PERSONAL_ENTRIES_SQL = `
  SELECT title, type FROM entries
  WHERE scope = 'personal' AND status = 'active'
    AND developer_id = ?
  ORDER BY last_confirmed DESC
  LIMIT 3
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
 * @returns Object containing agent context string and user summary string.
 */
export function generateSessionContext(opts: SessionContextOptions): SessionContextResult {
  const { db, projectDir, maxTokens = 500, developerId, globalDb } = opts;

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

  const personalRows: PersonalEntryRow[] = [];
  if (developerId) {
    personalRows.push(...db.query<PersonalEntryRow, [string]>(PERSONAL_ENTRIES_SQL).all(developerId));
    if (globalDb) {
      personalRows.push(...globalDb.query<PersonalEntryRow, [string]>(PERSONAL_ENTRIES_SQL).all(developerId));
    }
  }

  // 1. Build Agent Context (Markdown for LLM)
  const agentSections: string[] = ["# Gyst Context"];

  if (topFileRows.length > 0) {
    const lines = topFileRows.map((r) => `- ${r.file_path}`).join("\n");
    agentSections.push(`## Already Indexed Files (Do NOT re-read)\n${lines}`);
  }

  if (ghostRows.length > 0) {
    const lines = ghostRows.map((r) => `- ${r.title}`).join("\n");
    agentSections.push(`## Team Rules\n${lines}`);
  }

  if (personalRows.length > 0) {
    const lines = personalRows.map((r) => `- ${r.title} (${r.type})`).join("\n");
    agentSections.push(`## Your Recent Personal Memories\n${lines}`);
  }

  if (conventionRows.length > 0) {
    const lines = conventionRows.map((r) => `- ${r.title}`).join("\n");
    agentSections.push(`## Conventions (${projectDir})\n${lines}`);
  }

  if (errorRows.length > 0) {
    const r = errorRows[0];
    agentSections.push(`## Recent Error Pattern\n- ${r.title} (confidence: ${r.confidence.toFixed(2)})`);
  }

  const agentText = truncateToTokenBudget(agentSections.join("\n"), maxTokens);

  // 2. Build User Summary (Human-friendly notification)
  const summaryLines: string[] = ["🧠 Gyst Memory Active"];
  summaryLines.push("---------------------------------");
  
  if (ghostRows.length > 0) {
    summaryLines.push(`🚩 Team Rules: ${ghostRows.length} active`);
  }
  
  if (personalRows.length > 0) {
    summaryLines.push(`👤 Personal Memories: ${personalRows.length} loaded`);
  }

  if (conventionRows.length > 0) {
    summaryLines.push(`📏 Conventions: ${conventionRows.length} for current path`);
  }

  if (errorRows.length > 0) {
    summaryLines.push(`🕒 Recent Fix: "${errorRows[0].title}"`);
  }

  if (summaryLines.length === 2) {
    // If only header and line, it was empty
    return { agentContext: "", userSummary: "" };
  }

  return {
    agentContext: agentText,
    userSummary: summaryLines.join("\n")
  };
}
