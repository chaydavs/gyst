/**
 * Shared entry-fetching helpers used by multiple MCP tools.
 *
 * Centralises scope-visibility logic and DB→camelCase mapping so tools like
 * `recall`, `failures`, and `conventions` all apply identical access rules.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  status: string;
  createdAt: string;
  lastConfirmed: string;
  sourceCount: number;
  sourceTool: string | null;
  developerId: string | null;
}

/** Raw shape returned directly by bun:sqlite before camelCase mapping. */
interface RawRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  status: string;
  created_at: string;
  last_confirmed: string;
  source_count: number;
  source_tool: string | null;
  developer_id: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELECT_COLS = `
  id, type, title, content, confidence, scope, status,
  created_at, last_confirmed, source_count, source_tool, developer_id
`.trim();

function mapRow(r: RawRow): EntryRow {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    confidence: r.confidence,
    scope: r.scope,
    status: r.status,
    createdAt: r.created_at,
    lastConfirmed: r.last_confirmed,
    sourceCount: r.source_count,
    sourceTool: r.source_tool,
    developerId: r.developer_id,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a WHERE clause fragment + params for scope-based visibility.
 * Team/project entries are visible to everyone.
 * Personal entries are only visible when developerId matches.
 */
export function scopeVisibilityClause(
  developerId?: string,
  includeAllPersonal = false,
): {
  sql: string;
  params: readonly string[];
} {
  if (developerId !== undefined) {
    return {
      sql: "AND (scope IN ('team', 'project') OR (scope = 'personal' AND developer_id = ?))",
      params: [developerId],
    };
  }
  if (includeAllPersonal) {
    // Personal mode with no developer_id — single user, all entries visible.
    return { sql: "", params: [] };
  }
  return {
    sql: "AND scope IN ('team', 'project')",
    params: [],
  };
}

/**
 * Fetches a single entry by id, applying scope visibility rules.
 * Returns null if not found or not visible to the caller.
 */
export function getEntryById(
  db: Database,
  id: string,
  developerId?: string,
): EntryRow | null {
  const { sql: scopeSql, params: scopeParams } =
    scopeVisibilityClause(developerId);

  const sql = `
    SELECT ${SELECT_COLS}
    FROM   entries
    WHERE  id = ?
      AND  status = 'active'
      ${scopeSql}
  `;

  const row = db
    .query<RawRow, string[]>(sql)
    .get(id, ...(scopeParams as string[]));

  return row !== null && row !== undefined ? mapRow(row) : null;
}

/**
 * Batch-fetches entries by id list, preserving input order.
 * Applies scope visibility rules. Only returns active entries.
 */
export function fetchEntriesByIds(
  db: Database,
  ids: readonly string[],
  developerId?: string,
  includeAllPersonal = false,
): readonly EntryRow[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const { sql: scopeSql, params: scopeParams } =
    scopeVisibilityClause(developerId, includeAllPersonal);

  const sql = `
    SELECT ${SELECT_COLS}
    FROM   entries
    WHERE  id IN (${placeholders})
      AND  status = 'active'
      ${scopeSql}
  `;

  const params: string[] = [...ids, ...(scopeParams as string[])];
  const rows = db.query<RawRow, string[]>(sql).all(...params);

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [mapRow(row)] : [];
  });
}
