#!/usr/bin/env bun
/**
 * CLI command: gyst harvest-session
 *
 * Reads the most recent Claude Code session transcript from
 * ~/.claude/projects/[project]/sessions/ and runs it through the
 * harvest pipeline. This is what the PreCompact hook calls to
 * auto-extract knowledge before context compaction.
 *
 * Auto-harvest hook (add to .claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "PreCompact": [{
 *         "matcher": "auto",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "gyst harvest-session"
 *         }]
 *       }]
 *     }
 *   }
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { initDatabase } from "../store/database.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { harvestTranscript } from "../mcp/tools/harvest.js";

/** Maximum bytes to read from a session file to stay within the 100KB limit. */
const MAX_SESSION_BYTES = 100_000;

/**
 * Converts the current working directory to the slug format used by
 * Claude Code when naming project directories under ~/.claude/projects/.
 *
 * Claude Code replaces each path separator and space with a hyphen and
 * removes leading/trailing hyphens.
 *
 * @param cwd - Absolute directory path.
 * @returns Slug string.
 */
function cwdToSlug(cwd: string): string {
  return cwd.replace(/[/\\: ]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Recursively collects all file paths under a directory.
 *
 * @param dir - Root directory to search.
 * @returns Array of absolute file paths (not directories).
 */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        const nested = collectFiles(full);
        for (const f of nested) {
          results.push(f);
        }
      } else {
        results.push(full);
      }
    } catch {
      // Skip unreadable paths
    }
  }

  return results;
}

/**
 * Finds the path of the most recently modified file under the given directory.
 *
 * @param dir - Root directory to search.
 * @returns Absolute path of the newest file, or null if the directory is empty.
 */
function findNewestFile(dir: string): string | null {
  const files = collectFiles(dir);
  if (files.length === 0) return null;

  let newest: string | null = null;
  let newestMtime = 0;

  for (const file of files) {
    try {
      const stat = statSync(file);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = file;
      }
    } catch {
      // Skip unreadable paths
    }
  }

  return newest;
}

/**
 * Main logic for the harvest-session CLI command.
 *
 * Discovers the newest session file for the current project, reads up to
 * 100 KB, runs the harvest pipeline, and prints the result summary.
 * Errors are caught and logged so the PreCompact hook never blocks.
 */
export async function runHarvestSession(): Promise<void> {
  const cwd = process.cwd();
  const slug = cwdToSlug(cwd);
  const projectsDir = join(homedir(), ".claude", "projects");
  const projectDir = join(projectsDir, slug);

  if (!existsSync(projectDir)) {
    process.stdout.write(
      `gyst harvest-session: no session directory found at ${projectDir}\n`,
    );
    logger.info("harvest-session: project directory not found", {
      projectDir,
    });
    return;
  }

  const sessionFile = findNewestFile(projectDir);
  if (sessionFile === null) {
    process.stdout.write(
      `gyst harvest-session: no session files found in ${projectDir}\n`,
    );
    logger.info("harvest-session: no session files found", { projectDir });
    return;
  }

  logger.info("harvest-session: reading session file", { path: sessionFile });

  // Read up to MAX_SESSION_BYTES to respect the harvest tool's 100KB limit.
  let transcript: string;
  try {
    const buffer = readFileSync(sessionFile);
    const sliced =
      buffer.length > MAX_SESSION_BYTES
        ? buffer.subarray(0, MAX_SESSION_BYTES)
        : buffer;
    transcript = sliced.toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`gyst harvest-session: failed to read session file — ${msg}\n`);
    logger.error("harvest-session: read failed", { path: sessionFile, error: msg });
    return;
  }

  if (transcript.trim().length === 0) {
    process.stdout.write("gyst harvest-session: session file is empty — nothing to harvest\n");
    return;
  }

  const config = loadConfig();
  const db = initDatabase(config.dbPath);

  try {
    const result = harvestTranscript(db, {
      transcript,
      session_id: basename(sessionFile),
    });

    const summary =
      `gyst harvest-session: ${result.entriesCreated} created, ` +
      `${result.entriesMerged} merged, ${result.entriesSkipped} skipped\n`;

    process.stdout.write(summary);
    logger.info("harvest-session: complete", {
      created: result.entriesCreated,
      merged: result.entriesMerged,
      skipped: result.entriesSkipped,
    });
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  runHarvestSession().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("harvest-session failed", { error: msg });
    // Hook must never block — always exit 0
    process.exit(0);
  });
}
