#!/usr/bin/env bun
/**
 * Seed the real .gyst/wiki.db + gyst-wiki/ markdown files from the eval fixtures.
 *
 * The eval harness seeds into a /tmp temp DB, which means the real wiki
 * stays empty during development. This script uses the same 55-entry
 * fixture to populate the checked-in wiki once so the project can
 * dogfood itself and contributors see what the wiki looks like in action.
 *
 * Run: bun run scripts/seed-wiki.ts
 *
 * Safe to re-run — insertEntry uses INSERT OR IGNORE semantics via the
 * Gyst deduplication pipeline, so re-running will merge rather than
 * duplicate.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canLoadExtensions, initDatabase, insertEntry } from "../src/store/database.js";
import type { EntryRow } from "../src/store/database.js";
import { writeEntry } from "../src/compiler/writer.js";
import {
  initVectorStore,
  backfillVectors,
} from "../src/store/embeddings.js";
import { loadConfig } from "../src/utils/config.js";
import { logger } from "../src/utils/logger.js";

interface FixtureEntry extends EntryRow {
  readonly errorSignature?: string;
}

async function main(): Promise<void> {
  const here = fileURLToPath(import.meta.url);
  const projectRoot = resolve(here, "../..");
  const fixturesPath = join(projectRoot, "tests/fixtures/real-entries.json");

  process.stdout.write(`Reading fixtures from ${fixturesPath}\n`);
  const raw = readFileSync(fixturesPath, "utf8");
  const entries = JSON.parse(raw) as FixtureEntry[];
  process.stdout.write(`Loaded ${entries.length} fixture entries\n\n`);

  const config = loadConfig();
  process.stdout.write(`Target wiki dir: ${config.wikiDir}\n`);
  process.stdout.write(`Target db path:  ${config.dbPath}\n\n`);

  // Ensure subdirectories exist so writeEntry doesn't fail on first run.
  const subdirs = ["errors", "conventions", "decisions", "learnings"] as const;
  mkdirSync(config.wikiDir, { recursive: true });
  for (const sub of subdirs) {
    mkdirSync(join(config.wikiDir, sub), { recursive: true });
  }

  const db = initDatabase(config.dbPath);

  // Semantic search for backfill
  let vectorStoreReady = false;
  if (canLoadExtensions()) {
    vectorStoreReady = initVectorStore(db);
  }

  let insertedCount = 0;
  let markdownCount = 0;

  for (const entry of entries) {
    try {
      insertEntry(db, {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        content: entry.content,
        files: entry.files,
        tags: entry.tags,
        errorSignature: entry.errorSignature,
        confidence: entry.confidence,
        sourceCount: entry.sourceCount,
        sourceTool: entry.sourceTool,
        status: entry.status ?? "active",
      });
      insertedCount += 1;

      // Convert DB EntryRow to the KnowledgeEntry shape writeEntry needs.
      const knowledgeEntry = {
        id: entry.id,
        type: entry.type as "error_pattern" | "convention" | "decision" | "learning" | "ghost_knowledge",
        title: entry.title,
        content: entry.content,
        files: [...entry.files],
        tags: [...entry.tags],
        errorSignature: entry.errorSignature,
        confidence: entry.confidence,
        sourceCount: entry.sourceCount,
        sourceTool: entry.sourceTool,
        createdAt: entry.createdAt ?? new Date().toISOString(),
        lastConfirmed: entry.lastConfirmed ?? new Date().toISOString(),
        status: (entry.status ?? "active") as "active" | "stale" | "conflicted" | "archived",
        scope: (entry.scope ?? "team") as "personal" | "team" | "project",
      };

      const filePath = writeEntry(knowledgeEntry, config.wikiDir);
      markdownCount += 1;
      if (markdownCount <= 5) {
        process.stdout.write(`  + ${filePath.replace(projectRoot + "/", "")}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  ! skipped ${entry.id}: ${msg}\n`);
    }
  }

  if (markdownCount > 5) {
    process.stdout.write(`  ... and ${markdownCount - 5} more markdown files\n`);
  }

  process.stdout.write(`\nInserted ${insertedCount} rows into SQLite\n`);
  process.stdout.write(`Wrote ${markdownCount} markdown files to ${config.wikiDir}/\n`);

  if (vectorStoreReady) {
    process.stdout.write("\nBackfilling vector embeddings...\n");
    const embedStart = performance.now();
    const n = await backfillVectors(db);
    const embedMs = performance.now() - embedStart;
    process.stdout.write(`Embedded ${n} entries in ${embedMs.toFixed(0)}ms\n`);
  } else {
    process.stdout.write("\nSkipping vector backfill — system SQLite extension loading unavailable\n");
  }

  db.close();
  process.stdout.write("\nDone. Try: bun run recall 'postgres connection pool'\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error("seed-wiki failed", { error: msg });
  process.stderr.write(`seed-wiki failed: ${msg}\n`);
  process.exit(1);
});
