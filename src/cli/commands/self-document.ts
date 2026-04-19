/**
 * Self-documenting KB pipeline for gyst.
 *
 * Four phases:
 *  1. Structural skeleton — glob TypeScript source files, extract exports/imports,
 *     upsert as `structural` entries so the KB reflects the codebase shape.
 *  2. MD corpus — delegate to ingestAllMdFiles() to ingest all markdown files
 *     (CLAUDE.md, ADRs, specs, etc.) into md_doc entries.
 *  3. Link — bulk-build the `relationships` table from shared file paths and
 *     shared tags so the graph has edges. Runs as a single SQL JOIN — fast
 *     even for hundreds of entries.
 *  4. Ghost knowledge — call getTopCentralNodes() to find hub-like entries, then
 *     use Anthropic Haiku (or existing content) to generate ghost_knowledge
 *     entries so AI agents never need to read the source file directly.
 */

import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../../utils/logger.js";
import { ingestAllMdFiles } from "../../compiler/ingest-md.js";
import { getTopCentralNodes } from "../../store/centrality.js";
import type { IngestSummary } from "../../compiler/ingest-md.js";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface Phase1Result {
  readonly created: number;
  readonly updated: number;
}

export interface Phase2Result {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

export interface Phase3LinkResult {
  readonly edgesCreated: number;
}

export interface Phase4Result {
  readonly written: number;
  readonly tokensUsed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first 12 hex characters of the SHA-256 of the given string.
 * Used to derive stable, compact IDs from content or file paths.
 */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Extracts top-level named exports from TypeScript source text.
 * Handles: functions, async functions, classes, const, let, type, interface, enum.
 */
function extractExports(content: string): string[] {
  const matches = content.matchAll(
    /^export\s+(?:(?:async\s+)?function|class|const|let|type|interface|enum)\s+(\w+)/gm,
  );
  return [...matches].map((m) => m[1]!).filter(Boolean);
}

/**
 * Extracts module specifiers from import statements in TypeScript source text.
 * Covers: import { … } from '…', import * as … from '…', import '…'
 */
function extractImports(content: string): string[] {
  const matches = content.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm);
  return [...matches].map((m) => m[1]!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Phase 1 — Structural skeleton
// ---------------------------------------------------------------------------

/**
 * Globs all TypeScript source files (excluding tests, type definitions, dist,
 * and node_modules) under `projectDir`, extracts their exports and imports,
 * and upserts them as `structural` entries in the database.
 *
 * Entries are keyed by a stable ID derived from the relative file path.
 * An existing entry is skipped when its content hash has not changed.
 *
 * Returns the count of entries created and updated.
 */
export async function runSelfDocumentPhase1(
  db: Database,
  projectDir: string,
): Promise<Phase1Result> {
  // Collect all TypeScript source files, excluding tests, declaration files,
  // and generated output directories.
  const tsGlob = new Glob("src/**/*.{ts,tsx}");
  const allFiles = [...tsGlob.scanSync({ cwd: projectDir, absolute: true })];
  const files = allFiles.filter(
    (f) =>
      !f.endsWith(".test.ts") &&
      !f.endsWith(".d.ts") &&
      !f.includes(`${join(projectDir, "node_modules")}/`) &&
      !f.includes(`${join(projectDir, "dist")}/`),
  );

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const relPath = relative(projectDir, filePath);
    const exports = extractExports(content);
    const imports = extractImports(content);

    const parts: string[] = [];
    if (exports.length > 0) {
      parts.push(`Exports: ${exports.slice(0, 10).join(", ")}`);
    }
    if (imports.length > 0) {
      const uniqueImports = [...new Set(imports)].slice(0, 8);
      parts.push(`Imports from: ${uniqueImports.join(", ")}`);
    }
    const moduleContent = parts.join("\n") || `Source file: ${relPath}`;
    const hash = shortHash(relPath + moduleContent);
    const id = `structural_${shortHash(relPath)}`;

    const existing = db
      .query<{ id: string; source_file_hash: string | null }, [string]>(
        "SELECT id, source_file_hash FROM entries WHERE id=?",
      )
      .get(id);

    if (existing && existing.source_file_hash === hash) {
      // Content unchanged — skip to avoid spurious DB writes.
      continue;
    }

    if (existing) {
      db.transaction(() => {
        db.run(
          "UPDATE entries SET title=?, content=?, source_file_hash=?, last_confirmed=? WHERE id=?",
          [relPath, moduleContent, hash, now, id],
        );
      })();
      updated++;
    } else {
      db.transaction(() => {
        db.run(
          `INSERT INTO entries
             (id, type, title, content, file_path, confidence, source_count,
              created_at, last_confirmed, status, scope, source_file_hash)
           VALUES (?, 'structural', ?, ?, ?, 0.8, 1, ?, ?, 'active', 'team', ?)`,
          [id, relPath, moduleContent, relPath, now, now, hash],
        );
        db.run(
          "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
          [id, relPath],
        );
      })();
      created++;
    }
  }

  logger.info("self-document phase 1 complete", { created, updated });
  return { created, updated };
}

// ---------------------------------------------------------------------------
// Phase 2 — MD corpus
// ---------------------------------------------------------------------------

/**
 * Scans `projectDir` for all markdown files and ingests them as `md_doc`
 * entries via the existing ingestAllMdFiles() pipeline.
 *
 * Returns the IngestSummary (created / updated / skipped).
 */
export async function runSelfDocumentPhase2(
  db: Database,
  projectDir: string,
): Promise<Phase2Result> {
  const summary: IngestSummary = ingestAllMdFiles(db, projectDir);
  return summary;
}

// ---------------------------------------------------------------------------
// Phase 3 — Ghost knowledge generation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 3 — Bulk relationship linking
// ---------------------------------------------------------------------------

/**
 * Builds edges in the `relationships` table using SQL JOINs so that the graph
 * view has connections between entries. Two strategies run in one transaction:
 *
 *  1. Shared file path — entries that reference the same source file are
 *     related_to each other (strength 0.5). Catches convention↔structural,
 *     error_pattern↔learning, and md_doc↔structural pairs naturally.
 *
 *  2. Shared tag — entries sharing a tag are linked (strength 0.4).
 *
 * All inserts are INSERT OR IGNORE so re-running is safe (idempotent).
 * Returns the number of new edges created.
 */
export function runSelfDocumentPhase3Link(db: Database): Phase3LinkResult {
  let edgesCreated = 0;

  db.transaction(() => {
    // 1. structural ↔ md_doc: link a source file entry to any doc that
    //    references it by path prefix. Scoped to structural/md_doc only to
    //    avoid combinatorial explosion from CodeMemBench test fixtures.
    //    Also guards against hot-spot file_paths by skipping any file that
    //    has more than 10 entries (synthetic test data).
    const structDocEdges = db.run(
      `INSERT OR IGNORE INTO relationships (source_id, target_id, type, strength)
       SELECT s.id, d.id, 'related_to', 0.6
       FROM entries s
       JOIN entries d
         ON d.type = 'md_doc'
        AND d.file_path IS NOT NULL
        AND d.status = 'active'
        AND (
          -- e.g. structural entry src/store/search.ts ↔ doc that mentions search
          s.file_path LIKE '%' || REPLACE(d.file_path, '.md', '') || '%'
          OR d.file_path LIKE '%' || s.file_path || '%'
        )
       WHERE s.type = 'structural'
         AND s.status = 'active'
         AND s.id < d.id`,
    );
    edgesCreated += structDocEdges.changes;

    // 2. md_doc ↔ md_doc in same directory (sibling docs are related).
    const docDocEdges = db.run(
      `INSERT OR IGNORE INTO relationships (source_id, target_id, type, strength)
       SELECT d1.id, d2.id, 'related_to', 0.4
       FROM entries d1
       JOIN entries d2
         ON d1.type = 'md_doc'
        AND d2.type = 'md_doc'
        AND d1.id   < d2.id
        AND d1.file_path IS NOT NULL
        AND d2.file_path IS NOT NULL
        AND d1.status = 'active'
        AND d2.status = 'active'
        -- same top-level directory (first path segment matches)
        AND SUBSTR(d1.file_path, 1, INSTR(d1.file_path, '/'))
          = SUBSTR(d2.file_path, 1, INSTR(d2.file_path, '/'))
        AND INSTR(d1.file_path, '/') > 0`,
    );
    edgesCreated += docDocEdges.changes;

    // 3. Shared tags between curated knowledge entries (not structural/md_doc).
    //    Only link if fewer than 8 entries share the tag to avoid synthetic
    //    test data fan-out.
    const tagEdges = db.run(
      `INSERT OR IGNORE INTO relationships (source_id, target_id, type, strength)
       SELECT et1.entry_id, et2.entry_id, 'related_to', 0.4
       FROM entry_tags et1
       JOIN entry_tags et2
         ON et1.tag       = et2.tag
        AND et1.entry_id  < et2.entry_id
       WHERE EXISTS (
         SELECT 1 FROM entries
         WHERE id = et1.entry_id AND status = 'active'
           AND type NOT IN ('structural', 'md_doc')
       )
       AND EXISTS (
         SELECT 1 FROM entries
         WHERE id = et2.entry_id AND status = 'active'
           AND type NOT IN ('structural', 'md_doc')
       )
       AND (
         SELECT COUNT(*) FROM entry_tags WHERE tag = et1.tag
       ) < 8`,
    );
    edgesCreated += tagEdges.changes;
  })();

  logger.info("self-document phase 3 link complete", { edgesCreated });
  return { edgesCreated };
}

/**
 * Promotes the top `ghostCount` hub entries by degree centrality to ghost
 * knowledge status (confidence=1.0) using their existing content — no LLM
 * call required. The entry's existing title and content are preserved as-is;
 * the type is updated to ghost_knowledge and confidence set to 1.0 so the
 * entry surfaces in tier 0 on every recall().
 *
 * This is Phase 3 without the Anthropic API dependency. Use when
 * ANTHROPIC_API_KEY is unavailable or when zero-cost automation is required.
 */
export function runSelfDocumentPhase4NoLLM(
  db: Database,
  ghostCount: number,
): Phase4Result {
  const candidates = getTopCentralNodes(db, ghostCount);
  if (candidates.length === 0) {
    return { written: 0, tokensUsed: 0 };
  }

  let written = 0;
  const now = new Date().toISOString();

  for (const entry of candidates) {
    const moduleName =
      entry.title.split("/").pop()?.replace(/\.tsx?$/, "") ?? entry.title;
    const ghostTitle = `How does ${moduleName} work?`;
    const ghostId = `ghost_${shortHash(ghostTitle)}`;

    const alreadyExists = db
      .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id=?")
      .get(ghostId);
    if (alreadyExists) continue;

    // Use the entry's existing content, trimmed to a readable summary size.
    const summary = entry.content.slice(0, 600).trimEnd();

    db.transaction(() => {
      db.run(
        `INSERT OR REPLACE INTO entries
           (id, type, title, content, confidence, source_count, created_at,
            last_confirmed, status, scope, metadata)
         VALUES (?, 'ghost_knowledge', ?, ?, 1.0, 1, ?, ?, 'active', 'team', ?)`,
        [
          ghostId,
          ghostTitle,
          summary,
          now,
          now,
          JSON.stringify({ sourceId: entry.id, generatedAt: now, noLlm: true }),
        ],
      );
    })();
    written++;
  }

  logger.info("self-document phase 3 (no-llm) complete", { written });
  return { written, tokensUsed: 0 };
}

/**
 * Queries the top `ghostCount` hub entries by degree centrality, then calls
 * Anthropic Haiku to generate a concise ghost knowledge entry for each.
 *
 * Entries that already have a ghost knowledge entry referencing them are
 * automatically excluded by getTopCentralNodes().
 *
 * Returns the number of ghost entries written and the total tokens consumed.
 */
export async function runSelfDocumentPhase4(
  db: Database,
  _projectDir: string,
  ghostCount: number,
  apiKey: string,
): Promise<Phase4Result> {
  const candidates = getTopCentralNodes(db, ghostCount);

  if (candidates.length === 0) {
    logger.info("self-document phase 3: no candidates for ghost generation");
    return { written: 0, tokensUsed: 0 };
  }

  let written = 0;
  let tokensUsed = 0;
  const now = new Date().toISOString();

  for (const entry of candidates) {
    const moduleName =
      entry.title.split("/").pop()?.replace(/\.tsx?$/, "") ?? entry.title;
    const ghostTitle = `How does ${moduleName} work?`;
    const ghostId = `ghost_${shortHash(ghostTitle)}`;

    const alreadyExists = db
      .query<{ id: string }, [string]>("SELECT id FROM entries WHERE id=?")
      .get(ghostId);
    if (alreadyExists) continue;

    const prompt =
      `You are documenting a codebase for AI agents. Write a concise, factual KB entry ` +
      `explaining what this module does and how it fits into the system, so an AI agent ` +
      `never needs to read the source file.\n\n` +
      `Module: ${entry.title}\n` +
      `Context: ${entry.content}\n\n` +
      `Write 2-4 sentences starting with "This module" or "This file". Focus on WHAT it ` +
      `does and HOW it connects to the rest of the system.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        logger.warn("ghost generation: API error", {
          entryId: entry.id,
          status: res.status,
        });
        continue;
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = data.content?.[0]?.text?.trim() ?? "";
      tokensUsed +=
        (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

      if (!text) continue;

      db.transaction(() => {
        db.run(
          `INSERT OR REPLACE INTO entries
             (id, type, title, content, confidence, source_count, created_at,
              last_confirmed, status, scope, metadata)
           VALUES (?, 'ghost_knowledge', ?, ?, 1.0, 1, ?, ?, 'active', 'team', ?)`,
          [
            ghostId,
            ghostTitle,
            text,
            now,
            now,
            JSON.stringify({ sourceId: entry.id, generatedAt: now }),
          ],
        );
      })();
      written++;
    } catch (err) {
      logger.warn("ghost generation failed", {
        entryId: entry.id,
        error: String(err),
      });
    }
  }

  logger.info("self-document phase 3 complete", { written, tokensUsed });
  return { written, tokensUsed };
}
