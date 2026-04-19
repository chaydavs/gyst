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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
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

// ---------------------------------------------------------------------------
// Phase 2: code comment mining
// ---------------------------------------------------------------------------

// Passed as an array to spawnSync — no shell interpolation, no injection risk.
const GREP_PATTERN = "TODO|FIXME|NOTE|HACK|// Why:|# Why:";
const GREP_EXCLUDE_DIRS = ["node_modules", "dist", "gyst-wiki", ".git"];

function commentToEntryType(
  line: string
): "convention" | "learning" | "error_pattern" {
  const upper = line.toUpperCase();
  if (upper.includes("FIXME") || upper.includes("HACK")) return "error_pattern";
  if (upper.includes("TODO")) return "convention";
  return "learning";
}

/**
 * Phase 2 of `gyst mine`: scans src/ for TODO/FIXME/NOTE/HACK/Why: markers
 * and stores each unique comment as a KB entry. Uses spawnSync with array
 * args to avoid shell injection. Returns the number of new entries created.
 */
export async function mineCommentsPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash">
): Promise<number> {
  let count = 0;
  try {
    const srcDir = join(opts.repoRoot, "src");
    if (!existsSync(srcDir)) return 0;

    const excludeArgs = GREP_EXCLUDE_DIRS.flatMap((d) => ["--exclude-dir", d]);
    // spawnSync with array args — shell never invoked, srcDir not interpolated
    const result = spawnSync(
      "grep",
      ["-rn", "--include=*.ts", "--include=*.js", ...excludeArgs, "-E", GREP_PATTERN, srcDir],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    const raw = (result.stdout ?? "").trim();
    if (!raw) return 0;

    for (const line of raw.split("\n").filter(Boolean)) {
      // Format: /abs/path/file.ts:42:  // TODO: ...
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const afterPath = line.slice(colonIdx + 1);
      const secondColon = afterPath.indexOf(":");
      if (secondColon === -1) continue;
      const filePath = line.slice(0, colonIdx);
      const commentText = afterPath.slice(secondColon + 1).trim();
      if (!commentText) continue;

      const hash = contentHash(commentText);
      const alreadyStored = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM entries WHERE content LIKE ? LIMIT 1"
        )
        .get(`%mine:comment:${hash}%`);
      if (alreadyStored) continue;

      const entryType = commentToEntryType(commentText);
      const relPath = relative(opts.repoRoot, filePath);
      const title = commentText
        .replace(/^(TODO|FIXME|NOTE|HACK|\/\/\s*Why:|#\s*Why:)\s*/i, "")
        .slice(0, 80)
        .trim() || commentText.slice(0, 80);

      await addManualEntry(db, {
        type: entryType,
        title,
        content: `mine:comment:${hash}\nFile: ${relPath}\n\n${commentText}`,
        files: [relPath],
        tags: ["mined:comment"],
      });
      count++;
    }

    setMiningCursor(db, "last_comment_scan", new Date().toISOString());
  } catch (err) {
    logger.warn("mineCommentsPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}

// ---------------------------------------------------------------------------
// Phase 3: hot path mining
// ---------------------------------------------------------------------------

export interface HotPathEntry {
  readonly file: string;
  readonly count: number;
}

/**
 * Parses `git log --format= --name-only` output into a sorted list of
 * the most-edited files. Empty lines and git metadata lines are filtered out.
 */
export function parseHotPaths(raw: string, limit: number): HotPathEntry[] {
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("|") || trimmed.startsWith("commit ")) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }));
}

const HOTPATH_LIMIT = 20;
const HOTPATH_CONFIDENCE = 0.9;

/**
 * Phase 3 of `gyst mine`: identifies the top-20 most-edited files via
 * `git log --name-only` and creates ghost_knowledge entries for any hot files
 * not already covered by an existing ghost_knowledge entry.
 * Writes cursor `last_hotpath_scan` on completion.
 */
export async function mineHotPathsPhase(
  db: Database,
  opts: Omit<MineOptions, "commitHash">
): Promise<number> {
  let count = 0;
  try {
    const { default: simpleGit } = await import("simple-git");
    const git = simpleGit(opts.repoRoot);
    const isRepo = await git.checkIsRepo().catch(() => false);
    if (!isRepo) return 0;

    const raw = await git.raw(["log", "--format=", "--name-only"]);
    const hotFiles = parseHotPaths(raw, HOTPATH_LIMIT);

    for (const { file, count: editCount } of hotFiles) {
      const absPath = join(opts.repoRoot, file);
      if (!existsSync(absPath)) continue;

      const alreadyCovered = db
        .query<{ id: string }, [string]>(
          `SELECT e.id FROM entries e
           JOIN entry_files ef ON ef.entry_id = e.id
           WHERE e.type = 'ghost_knowledge' AND ef.file_path = ? LIMIT 1`
        )
        .get(file);
      if (alreadyCovered) continue;

      const title = `Hot path: ${file} (${editCount} edits)`;
      const content = [
        `mine:hotpath:${file}`,
        `Edit frequency: ${editCount} commits`,
        ``,
        `This is one of the most frequently modified files in the codebase.`,
        `File: ${file}`,
      ].join("\n");

      const id = contentHash(`hotpath:${file}`);
      const now = new Date().toISOString();
      db.run(
        `INSERT OR IGNORE INTO entries
         (id, type, title, content, confidence, scope, status, created_at, updated_at)
         VALUES (?, 'ghost_knowledge', ?, ?, ?, 'project', 'active', ?, ?)`,
        [id, title, content, HOTPATH_CONFIDENCE, now, now]
      );
      db.run("INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)", [id, file]);
      db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)", [id, "mined:hotpath"]);
      count++;
    }

    setMiningCursor(db, "last_hotpath_scan", new Date().toISOString());
  } catch (err) {
    logger.warn("mineHotPathsPhase: error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return count;
}
