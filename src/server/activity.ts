/**
 * Activity logging and querying for the Gyst HTTP server.
 *
 * Records every MCP tool invocation made by team members so teams can see
 * what their peers are learning / recalling in near-real-time.
 *
 * Schema:
 *   activity_log – append-only event log, indexed by (team_id, timestamp)
 *                  and (developer_id, timestamp).
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { DatabaseError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const ACTIVITY_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    team_id      TEXT    NOT NULL REFERENCES teams(id),
    developer_id TEXT    NOT NULL,
    action       TEXT    NOT NULL CHECK (action IN ('learn', 'recall', 'conventions', 'failures')),
    entry_id     TEXT,
    files        TEXT,
    timestamp    TEXT    NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_activity_team_time
     ON activity_log(team_id, timestamp)`,

  `CREATE INDEX IF NOT EXISTS idx_activity_developer
     ON activity_log(developer_id, timestamp)`,
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four MCP tool names that can be logged. */
export type ActivityAction = "learn" | "recall" | "conventions" | "failures";

/** A single row from `activity_log` with deserialized fields. */
export interface ActivityEntry {
  readonly id: number;
  readonly teamId: string;
  readonly developerId: string;
  readonly action: ActivityAction;
  readonly entryId: string | null;
  readonly files: readonly string[];
  readonly timestamp: string;
}

/** Summary of a developer's recent activity. */
export interface ActiveDeveloper {
  readonly developerId: string;
  readonly displayName: string;
  readonly actionCount: number;
  readonly lastSeen: string;
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Applies the activity_log table and indexes to an existing database.
 * Safe to call multiple times — all statements use `IF NOT EXISTS`.
 *
 * NOTE: Assumes the `teams` table already exists (created by initTeamSchema).
 *
 * @param db - Open bun:sqlite Database.
 */
export function initActivitySchema(db: Database): void {
  for (const stmt of ACTIVITY_SCHEMA_STATEMENTS) {
    db.run(stmt);
  }
  logger.debug("Activity schema applied");
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: number;
  team_id: string;
  developer_id: string;
  action: string;
  entry_id: string | null;
  files: string | null;
  timestamp: string;
}

interface ActiveDevRow {
  developer_id: string;
  display_name: string;
  action_count: number;
  last_seen: string;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Appends a single activity event to the log.
 *
 * @param db          - Open database connection.
 * @param teamId      - Team the developer belongs to.
 * @param developerId - Developer performing the action.
 * @param action      - MCP tool name.
 * @param entryId     - Optional knowledge entry ID (for `learn`).
 * @param files       - Optional list of affected file paths.
 * @throws {DatabaseError} On any SQLite failure.
 */
export function logActivity(
  db: Database,
  teamId: string,
  developerId: string,
  action: ActivityAction,
  entryId?: string,
  files?: readonly string[],
): void {
  const filesJson = files && files.length > 0 ? JSON.stringify(files) : null;
  const now = new Date().toISOString();

  try {
    db.run(
      `INSERT INTO activity_log (team_id, developer_id, action, entry_id, files, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [teamId, developerId, action, entryId ?? null, filesJson, now],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to log activity: ${msg}`);
  }

  logger.debug("Activity logged", { teamId, developerId, action, entryId });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns activity entries for a team within the last `hours` hours,
 * optionally excluding a specific developer (e.g. the calling developer).
 *
 * Results are returned newest-first.
 *
 * @param db                  - Open database connection.
 * @param teamId              - Team to query.
 * @param hours               - How far back to look.
 * @param excludeDeveloperId  - Optional developer ID to exclude from results.
 * @returns Array of deserialized ActivityEntry objects.
 */
export function getRecentActivity(
  db: Database,
  teamId: string,
  hours: number,
  excludeDeveloperId?: string,
): readonly ActivityEntry[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let rows: ActivityRow[];

  if (excludeDeveloperId !== undefined) {
    rows = db
      .query<ActivityRow, [string, string, string]>(
        `SELECT id, team_id, developer_id, action, entry_id, files, timestamp
         FROM   activity_log
         WHERE  team_id      = ?
         AND    timestamp   >= ?
         AND    developer_id != ?
         ORDER  BY timestamp DESC`,
      )
      .all(teamId, cutoff, excludeDeveloperId);
  } else {
    rows = db
      .query<ActivityRow, [string, string]>(
        `SELECT id, team_id, developer_id, action, entry_id, files, timestamp
         FROM   activity_log
         WHERE  team_id    = ?
         AND    timestamp >= ?
         ORDER  BY timestamp DESC`,
      )
      .all(teamId, cutoff);
  }

  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    developerId: row.developer_id,
    action: row.action as ActivityAction,
    entryId: row.entry_id,
    files: row.files !== null ? (JSON.parse(row.files) as string[]) : [],
    timestamp: row.timestamp,
  }));
}

/**
 * Returns a summary of developers active in a team within the last `hours`
 * hours, sorted by activity count descending.
 *
 * @param db     - Open database connection.
 * @param teamId - Team to query.
 * @param hours  - How far back to look.
 * @returns Array of ActiveDeveloper summaries.
 */
export function getActiveDevs(
  db: Database,
  teamId: string,
  hours: number,
): readonly ActiveDeveloper[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db
    .query<ActiveDevRow, [string, string]>(
      `SELECT
         al.developer_id,
         COALESCE(tm.display_name, al.developer_id) AS display_name,
         COUNT(*)                                    AS action_count,
         MAX(al.timestamp)                           AS last_seen
       FROM   activity_log al
       LEFT   JOIN team_members tm
              ON   tm.team_id      = al.team_id
              AND  tm.developer_id = al.developer_id
       WHERE  al.team_id    = ?
       AND    al.timestamp >= ?
       GROUP  BY al.developer_id
       ORDER  BY action_count DESC`,
    )
    .all(teamId, cutoff);

  return rows.map((row) => ({
    developerId: row.developer_id,
    displayName: row.display_name,
    actionCount: row.action_count,
    lastSeen: row.last_seen,
  }));
}
