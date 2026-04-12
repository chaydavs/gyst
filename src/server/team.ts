/**
 * Team management queries for the Gyst HTTP server and CLI.
 *
 * All functions are read-oriented (or revocation/removal writes) and operate
 * on the tables created by initTeamSchema (auth.ts).
 */

import type { Database } from "bun:sqlite";
import { DatabaseError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A member row returned from the database, with camelCase fields. */
export interface TeamMember {
  readonly teamId: string;
  readonly developerId: string;
  readonly displayName: string;
  readonly role: "admin" | "member" | "readonly";
  readonly joinedAt: string;
}

/** A condensed activity record for team dashboards. */
export interface ActivityEntry {
  readonly id: number;
  readonly developerId: string;
  readonly action: string;
  readonly entryId: string | null;
  readonly files: readonly string[];
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface TeamMemberRow {
  team_id: string;
  developer_id: string;
  display_name: string;
  role: string;
  joined_at: string;
}

interface ActivityRow {
  id: number;
  developer_id: string;
  action: string;
  entry_id: string | null;
  files: string | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Returns all current members of a team, ordered by join date ascending.
 *
 * @param db     - Open database connection.
 * @param teamId - Team to query.
 * @returns Array of TeamMember records.
 * @throws {DatabaseError} On any SQLite failure.
 */
export function getTeamMembers(db: Database, teamId: string): readonly TeamMember[] {
  try {
    const rows = db
      .query<TeamMemberRow, [string]>(
        `SELECT team_id, developer_id, display_name, role, joined_at
         FROM   team_members
         WHERE  team_id = ?
         ORDER  BY joined_at ASC`,
      )
      .all(teamId);

    return rows.map((row) => ({
      teamId: row.team_id,
      developerId: row.developer_id,
      displayName: row.display_name,
      role: row.role as "admin" | "member" | "readonly",
      joinedAt: row.joined_at,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to list team members: ${msg}`);
  }
}

/**
 * Returns activity log entries for a team within the last `hours` hours,
 * newest first.
 *
 * @param db     - Open database connection.
 * @param teamId - Team to query.
 * @param hours  - Look-back window in hours.
 * @returns Array of ActivityEntry records.
 * @throws {DatabaseError} On any SQLite failure.
 */
export function getTeamActivity(
  db: Database,
  teamId: string,
  hours: number,
): readonly ActivityEntry[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const rows = db
      .query<ActivityRow, [string, string]>(
        `SELECT id, developer_id, action, entry_id, files, timestamp
         FROM   activity_log
         WHERE  team_id    = ?
         AND    timestamp >= ?
         ORDER  BY timestamp DESC`,
      )
      .all(teamId, cutoff);

    return rows.map((row) => ({
      id: row.id,
      developerId: row.developer_id,
      action: row.action,
      entryId: row.entry_id,
      files: row.files !== null ? (JSON.parse(row.files) as string[]) : [],
      timestamp: row.timestamp,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to fetch team activity: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Write functions
// ---------------------------------------------------------------------------

/**
 * Revokes an API key by its hash, preventing further authentication.
 *
 * @param db      - Open database connection.
 * @param keyHash - The bcrypt hash of the key to revoke (never the plaintext).
 * @throws {DatabaseError} On any SQLite failure.
 */
export function revokeApiKey(db: Database, keyHash: string): void {
  try {
    db.run(
      `UPDATE api_keys SET revoked = 1 WHERE key_hash = ?`,
      [keyHash],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to revoke API key: ${msg}`);
  }

  logger.info("API key revoked", { keyHashPrefix: keyHash.slice(0, 12) });
}

/**
 * Removes a developer from a team and revokes all of their API keys.
 *
 * All writes are executed in a single transaction.
 *
 * @param db          - Open database connection.
 * @param teamId      - Team the developer belongs to.
 * @param developerId - Developer to remove.
 * @throws {DatabaseError} On any SQLite failure.
 */
export function removeMember(
  db: Database,
  teamId: string,
  developerId: string,
): void {
  try {
    db.transaction(() => {
      // Revoke all API keys belonging to this developer in this team
      db.run(
        `UPDATE api_keys
         SET    revoked = 1
         WHERE  team_id      = ?
         AND    developer_id = ?`,
        [teamId, developerId],
      );

      // Remove the member record
      db.run(
        `DELETE FROM team_members
         WHERE  team_id      = ?
         AND    developer_id = ?`,
        [teamId, developerId],
      );
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to remove member ${developerId}: ${msg}`);
  }

  logger.info("Member removed from team", { teamId, developerId });
}
