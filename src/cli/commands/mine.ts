/**
 * gyst mine — automated institutional knowledge extraction.
 *
 * Four phases:
 *  1. git      — commit messages from last_commit_hash to HEAD
 *  2. comments — TODO/FIXME/NOTE/HACK/Why: markers across src/
 *  3. hotpaths — top-20 most-edited files from git log
 *  4. tests    — top-level describe() names from integration/e2e/spec files
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/** Reads a mining cursor value (returns null when key absent). */
export function getMiningCursor(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM codebase_mining_state WHERE key = ?"
    )
    .get(key);
  return row?.value ?? null;
}

/** Upserts a mining cursor value. */
export function setMiningCursor(db: Database, key: string, value: string): void {
  db.run(
    "INSERT OR REPLACE INTO codebase_mining_state (key, value) VALUES (?, ?)",
    [key, value]
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Returns the first 16 hex chars of SHA-256(s). Used for dedup fingerprints. */
export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MineOptions {
  readonly commitHash?: string;
  readonly full: boolean;
  readonly noLlm: boolean;
  readonly repoRoot: string;
}

export interface MineResult {
  readonly git: number;
  readonly comments: number;
  readonly hotpaths: number;
  readonly tests: number;
}
