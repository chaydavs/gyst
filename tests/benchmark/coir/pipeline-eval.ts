#!/usr/bin/env bun
/**
 * CoIR ↔ Gyst full-pipeline bridge.
 *
 * stdin:  JSON { corpus: {did: {title, text}}, queries: {qid: text} }
 * stdout: JSON { results: {qid: {did: score}} }  (last line)
 *
 * Spawned per-subtask by tests/benchmark/coir/run-coir.py when --pipeline is
 * set. Builds a fresh temp Gyst DB, ingests every corpus doc as a
 * knowledge entry, backfills vectors, runs runHybridSearch() per query, and
 * emits the top-100 {did: fused-score} map. Python rescoring (pytrec_eval)
 * uses these scores to compute NDCG@10 / Recall@10 / MAP.
 *
 * Scores emitted here are *rank-derived* (1/(rank+1)) — the RRF fused score
 * is already rank-based, and pytrec_eval only cares about score ordering for
 * IR metrics, so this faithfully preserves Gyst's ranking without leaking
 * raw fusion internals.
 */

import { readFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  insertEntry,
  canLoadExtensions,
} from "../../../src/store/database.js";
import { initVectorStore, backfillVectors } from "../../../src/store/embeddings.js";
import { runHybridSearch } from "../../../src/store/hybrid.js";

interface CoirDoc {
  readonly title?: string;
  readonly text?: string;
}

interface Payload {
  readonly corpus: Record<string, CoirDoc>;
  readonly queries: Record<string, string>;
}

const TOP_K = 100;
const VALID_TYPES = ["error_pattern", "convention", "decision", "learning", "ghost_knowledge"] as const;

function readStdin(): string {
  const chunks: Buffer[] = [];
  const fd = 0;
  const buf = Buffer.alloc(1 << 16);
  try {
    for (;;) {
      const n = require("node:fs").readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // EOF on some platforms throws
  }
  return Buffer.concat(chunks).toString("utf8");
}

function typeFor(index: number): string {
  return VALID_TYPES[index % VALID_TYPES.length]!;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function sanitizeQueryForFts(query: string): string {
  // FTS5 reserved words break queries — strip them. Also remove anything
  // that could confuse the porter tokenizer (quotes, colons, parens).
  const reserved = new Set(["NEAR", "MATCH", "AND", "OR", "NOT"]);
  return query
    .replace(/["':()\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !reserved.has(w.toUpperCase()))
    .join(" ")
    .slice(0, 500);
}

async function main(): Promise<void> {
  const raw = readStdin();
  if (!raw.trim()) {
    process.stderr.write("pipeline-eval: empty stdin\n");
    process.exit(2);
  }
  const payload = JSON.parse(raw) as Payload;
  const corpusIds = Object.keys(payload.corpus);
  const queryIds = Object.keys(payload.queries);

  process.stderr.write(
    `pipeline-eval: ${corpusIds.length} docs / ${queryIds.length} queries\n`,
  );

  const tmpDir = mkdtempSync(join(tmpdir(), "gyst-coir-"));
  const dbPath = join(tmpDir, "coir.db");
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const db = initDatabase(dbPath);
  const semanticAvailable = canLoadExtensions();
  if (semanticAvailable) initVectorStore(db);

  const idMap = new Map<string, string>();
  let i = 0;
  for (const did of corpusIds) {
    const doc = payload.corpus[did] ?? {};
    const title = (doc.title ?? "").trim() || did;
    const text = (doc.text ?? "").trim();
    const safeId = sanitizeId(`coir_${i}_${did}`);
    idMap.set(safeId, did);
    insertEntry(db, {
      id: safeId,
      type: typeFor(i),
      title: title.slice(0, 200),
      content: text.slice(0, 8000),
      files: [`coir/${safeId}.md`],
      tags: ["coir"],
      confidence: 0.9,
      sourceCount: 1,
      sourceTool: "coir",
      scope: "team",
    });
    i++;
  }
  process.stderr.write(`pipeline-eval: ingest complete (${i})\n`);

  if (semanticAvailable) {
    process.stderr.write("pipeline-eval: backfilling vectors…\n");
    const count = await backfillVectors(db);
    process.stderr.write(`pipeline-eval: backfilled ${count}\n`);
  }

  const results: Record<string, Record<string, number>> = {};
  let q = 0;
  for (const qid of queryIds) {
    const rawQ = payload.queries[qid] ?? "";
    const cleaned = sanitizeQueryForFts(rawQ);
    const ranked = await runHybridSearch(db, cleaned);
    const scored: Record<string, number> = {};
    const top = ranked.slice(0, TOP_K);
    for (let r = 0; r < top.length; r++) {
      const safeId = top[r]!.id;
      const did = idMap.get(safeId);
      if (did === undefined) continue;
      scored[did] = 1 / (r + 1);
    }
    results[qid] = scored;
    q++;
    if (q % 50 === 0) {
      process.stderr.write(`pipeline-eval: ${q}/${queryIds.length} queries\n`);
    }
  }

  db.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);

  process.stdout.write(JSON.stringify({ results }) + "\n");
}

main().catch((err) => {
  process.stderr.write(`pipeline-eval failed: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
