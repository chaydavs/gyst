/**
 * API key authentication for the Gyst HTTP server.
 *
 * Provides team creation, invite-key exchange, and Bearer-token validation.
 * API keys are NEVER stored in plaintext — only their bcrypt hash is persisted.
 *
 * Key format:  gyst_<prefix>_<32 random hex chars>
 * Hash method: Bun.password.hash() (bcrypt-compatible)
 *
 * Schema (applied here as part of initTeamSchema):
 *   teams            – team records
 *   team_members     – developer membership rows
 *   api_keys         – hashed key registry with type/expiry/revoke
 */

import type { Database } from "bun:sqlite";
import { GystError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when an HTTP request fails authentication or authorisation.
 */
export class AuthError extends GystError {
  /** HTTP status code to return to the caller. */
  public readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403 = 401) {
    super(message, "AUTH_ERROR");
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Role a principal can hold within a team. */
export type TeamRole = "admin" | "member" | "invite" | "readonly";

/**
 * Resolved auth context attached to every authenticated request.
 * `developerId` is null for invite keys (one-time use, no member yet).
 */
export interface AuthContext {
  readonly teamId: string;
  readonly developerId: string | null;
  readonly role: TeamRole;
}

// ---------------------------------------------------------------------------
// DDL — team-related tables
// ---------------------------------------------------------------------------

/** DDL statements for the team schema, applied idempotently. */
const TEAM_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS teams (
    id         TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS team_members (
    team_id      TEXT NOT NULL REFERENCES teams(id),
    developer_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member'
                       CHECK (role IN ('admin', 'member', 'readonly')),
    joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, developer_id)
  )`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    key_hash     TEXT NOT NULL PRIMARY KEY,
    team_id      TEXT NOT NULL REFERENCES teams(id),
    developer_id TEXT,
    type         TEXT NOT NULL CHECK (type IN ('admin', 'member', 'invite')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT,
    revoked      INTEGER NOT NULL DEFAULT 0
  )`,
];

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Applies the team-related tables to an existing database connection.
 * Safe to call multiple times — all statements use `IF NOT EXISTS`.
 *
 * @param db - An open bun:sqlite Database (must have FK enforcement enabled).
 */
export function initTeamSchema(db: Database): void {
  for (const stmt of TEAM_SCHEMA_STATEMENTS) {
    db.run(stmt);
  }
  logger.debug("Team schema applied");
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Hashes an API key using Bun's built-in password hashing (bcrypt).
 * The result is safe to store in the database.
 *
 * @param key - Plaintext API key. NEVER log this value.
 * @returns Bcrypt hash string.
 */
export async function hashApiKey(key: string): Promise<string> {
  return Bun.password.hash(key, { algorithm: "bcrypt", cost: 10 });
}

/**
 * Verifies a plaintext key against a stored bcrypt hash.
 *
 * @param key  - Plaintext API key from the request.
 * @param hash - Stored bcrypt hash to compare against.
 */
async function verifyApiKey(key: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(key, hash);
  } catch {
    // hash is not a valid bcrypt/argon2 string (e.g. legacy UUID rows) — treat as no match.
    return false;
  }
}

/**
 * Generates a new API key with the given prefix.
 *
 * Format: `gyst_<prefix>_<32 random hex chars>`
 *
 * @param prefix - Short label, e.g. `"admin"`, `"member"`, `"invite"`.
 * @returns Plaintext API key. Caller must hash before persisting.
 */
export function generateApiKey(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `gyst_${prefix}_${random}`;
}

// ---------------------------------------------------------------------------
// Row types (internal)
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  key_hash: string;
  team_id: string;
  developer_id: string | null;
  type: string;
  expires_at: string | null;
  revoked: number;
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/**
 * Validates the `Authorization: Bearer <key>` header on an incoming request
 * and returns the resolved auth context.
 *
 * Checks performed (in order):
 *  1. Header present and well-formed.
 *  2. Key exists in `api_keys` table (iterated in insertion order; earliest
 *     matching hash wins — typical tables are small so linear scan is fine).
 *  3. Key has not been revoked.
 *  4. Key has not expired.
 *
 * NOTE: Bcrypt verification is O(cost) per candidate row.  For production
 * deployments with many keys, consider caching the resolved hash in a
 * short-lived in-process LRU keyed on a fast pre-hash (SHA-256).
 *
 * @param req - Web Standard Request object.
 * @param db  - Open database connection.
 * @returns Resolved AuthContext.
 * @throws {AuthError} If the key is missing, invalid, revoked, or expired.
 */
export async function authenticateRequest(
  req: Request,
  db: Database,
): Promise<AuthContext> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new AuthError("Missing Authorization header");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    throw new AuthError("Malformed Authorization header — expected: Bearer <key>");
  }

  const plainKey = parts[1];

  // Load all non-revoked key rows and test against them.
  // We cannot do a direct lookup by plaintext because we store only hashes.
  const rows = db
    .query<ApiKeyRow, []>(
      `SELECT key_hash, team_id, developer_id, type, expires_at, revoked
       FROM   api_keys
       WHERE  revoked = 0`,
    )
    .all();

  let matched: ApiKeyRow | null = null;
  for (const row of rows) {
    const ok = await verifyApiKey(plainKey, row.key_hash);
    if (ok) {
      matched = row;
      break;
    }
  }

  if (matched === null) {
    throw new AuthError("Invalid API key");
  }

  if (matched.revoked !== 0) {
    throw new AuthError("API key has been revoked");
  }

  if (matched.expires_at !== null) {
    const expiry = new Date(matched.expires_at);
    if (expiry < new Date()) {
      throw new AuthError("API key has expired");
    }
  }

  const role = matched.type as TeamRole;

  logger.debug("Request authenticated", {
    teamId: matched.team_id,
    developerId: matched.developer_id ?? "(invite)",
    role,
  });

  return {
    teamId: matched.team_id,
    developerId: matched.developer_id,
    role,
  };
}

// ---------------------------------------------------------------------------
// Team management
// ---------------------------------------------------------------------------

/**
 * Creates a new team and provisions an admin API key.
 *
 * All writes occur in a single transaction.
 *
 * @param db   - Open database connection.
 * @param name - Human-readable team name.
 * @returns `{ teamId, adminKey }` — caller must print `adminKey` exactly once.
 */
export function createTeam(
  db: Database,
  name: string,
): { teamId: string; adminKey: string } {
  const teamId = crypto.randomUUID();
  const adminKey = generateApiKey("admin");
  const now = new Date().toISOString();

  // Hash synchronously via a blocking call pattern — we wrap the async hash
  // in a sync-compatible approach using Bun's native bcrypt which supports
  // a synchronous path.
  const keyHash = Bun.password.hashSync(adminKey, { algorithm: "bcrypt", cost: 10 });

  db.transaction(() => {
    db.run(
      `INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)`,
      [teamId, name, now],
    );

    db.run(
      `INSERT INTO api_keys (key_hash, team_id, developer_id, type, created_at)
       VALUES (?, ?, NULL, 'admin', ?)`,
      [keyHash, teamId, now],
    );
  })();

  logger.info("Team created", { teamId, name });
  // Log only the hash, never the plaintext key.
  logger.debug("Admin key provisioned", { teamId, keyHashPrefix: keyHash.slice(0, 12) });

  return { teamId, adminKey };
}

/**
 * Creates a single-use invite key for a team.
 * The invite key has no associated developer_id — it gets one when redeemed.
 *
 * @param db     - Open database connection.
 * @param teamId - ID of the team to invite to.
 * @returns Plaintext invite key (caller prints once; not stored in plaintext).
 */
export function createInviteKey(db: Database, teamId: string): string {
  // Verify team exists
  const team = db
    .query<{ id: string }, [string]>("SELECT id FROM teams WHERE id = ?")
    .get(teamId);
  if (!team) {
    throw new AuthError(`Team not found: ${teamId}`, 403);
  }

  const inviteKey = generateApiKey("invite");
  const keyHash = Bun.password.hashSync(inviteKey, { algorithm: "bcrypt", cost: 10 });
  const now = new Date().toISOString();

  // Invite keys expire after 24 hours
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.run(
    `INSERT INTO api_keys (key_hash, team_id, developer_id, type, created_at, expires_at)
     VALUES (?, ?, NULL, 'invite', ?, ?)`,
    [keyHash, teamId, now, expiresAt],
  );

  logger.info("Invite key created", { teamId, expiresAt });

  return inviteKey;
}

/**
 * Exchanges a valid invite key for a permanent member API key.
 *
 * Steps:
 *  1. Verify and consume the invite key (revoke it).
 *  2. Create a new developer record in `team_members`.
 *  3. Provision a `member` API key linked to the new developer.
 *
 * @param db          - Open database connection.
 * @param inviteKey   - Plaintext invite key.
 * @param displayName - Human-readable name for the new member.
 * @returns `{ developerId, memberKey }`.
 * @throws {AuthError} If the invite key is invalid, expired, or already used.
 */
export async function joinTeam(
  db: Database,
  inviteKey: string,
  displayName: string,
): Promise<{ developerId: string; memberKey: string }> {
  // Find matching invite key row
  const rows = db
    .query<ApiKeyRow, []>(
      `SELECT key_hash, team_id, developer_id, type, expires_at, revoked
       FROM   api_keys
       WHERE  type    = 'invite'
       AND    revoked = 0`,
    )
    .all();

  let matchedRow: ApiKeyRow | null = null;
  for (const row of rows) {
    const ok = await verifyApiKey(inviteKey, row.key_hash);
    if (ok) {
      matchedRow = row;
      break;
    }
  }

  if (matchedRow === null) {
    throw new AuthError("Invalid or already-used invite key");
  }

  if (matchedRow.expires_at !== null) {
    const expiry = new Date(matchedRow.expires_at);
    if (expiry < new Date()) {
      throw new AuthError("Invite key has expired");
    }
  }

  const developerId = crypto.randomUUID();
  const memberKey = generateApiKey("member");
  const memberKeyHash = Bun.password.hashSync(memberKey, {
    algorithm: "bcrypt",
    cost: 10,
  });
  const now = new Date().toISOString();

  db.transaction(() => {
    // Revoke the invite key (one-time use)
    db.run(
      `UPDATE api_keys SET revoked = 1 WHERE key_hash = ?`,
      [matchedRow!.key_hash],
    );

    // Create team member record
    db.run(
      `INSERT INTO team_members (team_id, developer_id, display_name, api_key_hash, role, joined_at)
       VALUES (?, ?, ?, ?, 'member', ?)`,
      [matchedRow!.team_id, developerId, displayName, memberKeyHash, now],
    );

    // Provision permanent member API key
    db.run(
      `INSERT INTO api_keys (key_hash, team_id, developer_id, type, created_at)
       VALUES (?, ?, ?, 'member', ?)`,
      [memberKeyHash, matchedRow!.team_id, developerId, now],
    );
  })();

  logger.info("Developer joined team", {
    teamId: matchedRow.team_id,
    developerId,
    displayName,
  });

  return { developerId, memberKey };
}
