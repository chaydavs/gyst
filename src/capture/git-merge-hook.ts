#!/usr/bin/env bun
/**
 * Post-merge hook handler for Gyst.
 *
 * Called automatically by git after every `git pull` / `git merge`. Checks
 * whether any files inside `gyst-wiki/` changed as a result of the merge.
 * When wiki files are detected, it triggers a full rebuild of the SQLite index
 * from the markdown source of truth.
 *
 * This module MUST NOT fail the merge — all errors are caught and logged, and
 * the process always exits with code 0.
 */

import simpleGit from "simple-git";
import { rebuildFromMarkdown } from "../store/rebuild.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// handlePostMerge
// ---------------------------------------------------------------------------

/**
 * Entry point for the post-merge hook.
 *
 * Uses `git diff --name-only ORIG_HEAD HEAD` to identify files that the merge
 * brought in. When any of those files sit inside the configured `wikiDir`,
 * `rebuildFromMarkdown` is invoked to regenerate the SQLite index.
 *
 * @returns A promise that resolves once the rebuild finishes (or is skipped).
 */
export async function handlePostMerge(): Promise<void> {
  const git = simpleGit();
  const config = loadConfig();

  // git diff ORIG_HEAD..HEAD shows exactly what the merge introduced.
  // On the very first merge where ORIG_HEAD does not exist this throws — catch
  // it gracefully and fall through to a full rebuild as a safe default.
  let changedFiles: string[];
  try {
    const diff = await git.diff(["--name-only", "ORIG_HEAD", "HEAD"]);
    changedFiles = diff
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("handlePostMerge: could not diff ORIG_HEAD..HEAD, rebuilding anyway", {
      error: msg,
    });
    // Treat as if everything changed — rebuild unconditionally.
    changedFiles = [config.wikiDir + "/"];
  }

  // Normalise wikiDir to always use forward slashes for cross-platform matching.
  const wikiPrefix = config.wikiDir.replace(/\\/g, "/");

  const wikiChanges = changedFiles.filter((f) => {
    const normalised = f.replace(/\\/g, "/");
    return normalised.startsWith(wikiPrefix + "/") || normalised.startsWith(wikiPrefix);
  });

  if (wikiChanges.length === 0) {
    logger.debug("handlePostMerge: no wiki changes detected, skipping rebuild");
    return;
  }

  logger.info("handlePostMerge: wiki files changed in merge, rebuilding index", {
    count: wikiChanges.length,
    files: wikiChanges,
  });

  const stats = await rebuildFromMarkdown(config);

  logger.info("handlePostMerge: index rebuild complete", {
    total: stats.total,
    created: stats.created,
    updated: stats.updated,
    skipped: stats.skipped,
    errors: stats.errors,
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  handlePostMerge().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("handlePostMerge: unhandled error in post-merge hook", {
      error: message,
    });
    // Never fail the merge — always exit 0.
    process.exit(0);
  });
}
