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
import { logger } from "../../utils/logger.js";
import { addManualEntry } from "../../capture/manual.js";

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

// ---------------------------------------------------------------------------
// Phase 1: git commit message mining
// ---------------------------------------------------------------------------

const SKIP_SUBJECT_RE = /^(chore|bump|merge|revert)[:(]/i;

/**
 * Returns true when a commit subject line should be skipped during mining.
 * Skips chore/bump/merge/revert prefixes and bare "Merge …" messages.
 */
export function shouldSkipCommitSubject(subject: string): boolean {
  const trimmed = subject.trim();
  return SKIP_SUBJECT_RE.test(trimmed) || /^merge\b/i.test(trimmed);
}

const CC_TYPE_MAP: Record<string, "decision" | "learning" | "convention"> = {
  feat: "decision",
  refactor: "decision",
  fix: "learning",
  perf: "learning",
  docs: "convention",
  test: "convention",
};

/**
 * Maps a conventional commit type string to a knowledge entry type.
 * Falls back to "learning" for unknown types.
 */
export function conventionalTypeToEntryType(
  ccType: string
): "decision" | "learning" | "convention" {
  return CC_TYPE_MAP[ccType.toLowerCase()] ?? "learning";
}

/**
 * Phase 1 of `gyst mine`: walks git commit history and stores new commits
 * as knowledge entries. Returns the number of entries created.
 *
 * Uses a cursor (last_commit_hash) to process only new commits on
 * incremental runs; opts.full resets the cursor and replays all history.
 */
export async function mineGitPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash"> & { commitHash?: string }
): Promise<number> {
  let count = 0;
  try {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit(opts.repoRoot);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) return 0;

    const cursor = opts.full ? null : getMiningCursor(db, "last_commit_hash");

    const logArgs: string[] = ["log", "--format=%H|%s|%b|%ai|%an", "--no-merges"];
    if (opts.commitHash) {
      logArgs.push(opts.commitHash, "-1");
    } else if (cursor) {
      logArgs.push(`${cursor}..HEAD`);
    }

    const rawLog = await git.raw(logArgs);
    if (!rawLog.trim()) return 0;

    for (const line of rawLog.trim().split("\n")) {
      const pipeIdx = line.indexOf("|");
      if (pipeIdx === -1) continue;
      const hash = line.slice(0, pipeIdx);
      const parts = line.slice(pipeIdx + 1).split("|");
      const subject = parts[0]?.trim() ?? "";
      const body = parts[1]?.trim() ?? "";
      const author = parts[3]?.trim() ?? "";

      if (!hash || shouldSkipCommitSubject(subject)) continue;

      const alreadyStored = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM entries WHERE content LIKE ? LIMIT 1"
        )
        .get(`%mine:git:${hash}%`);
      if (alreadyStored) continue;

      const ccMatch = subject.match(/^(\w+)(?:\([^)]+\))?:/);
      const ccType = ccMatch?.[1] ?? "";
      const entryType = conventionalTypeToEntryType(ccType);
      const title = ccMatch
        ? subject.slice(subject.indexOf(":") + 1).trim()
        : subject;

      const content = [
        `mine:git:${hash}`,
        `Author: ${author}`,
        body ? `\n${body}` : "",
      ].join("\n").trim();

      await addManualEntry(db, {
        type: entryType,
        title: title || subject,
        content,
        tags: ["mined:git", `cc:${ccType || "none"}`],
      });
      count++;
    }

    if (!opts.commitHash) {
      const head = (await git.revparse(["HEAD"])).trim();
      if (head) setMiningCursor(db, "last_commit_hash", head);
    }
  } catch (err) {
    logger.warn("mineGitPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
