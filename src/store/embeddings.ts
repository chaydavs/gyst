/**
 * Semantic search strategy for Gyst (Strategy 5).
 *
 * Uses sqlite-vec + all-MiniLM-L6-v2 (via @xenova/transformers) to give
 * recall a meaning-based fallback that complements BM25's keyword matching.
 * This is what lets queries like "why did we choose bun" match an entry
 * titled "Decision: Migrate to Bun runtime" — BM25 can't see that
 * connection because the surface vocabulary doesn't overlap.
 *
 * Design:
 *   - Model: Xenova/all-MiniLM-L6-v2 (22MB ONNX, 384-dim float vectors)
 *   - Storage: sqlite-vec `vec0` virtual table keyed by entry ID
 *   - Distance: L2 (sqlite-vec default for float[])
 *   - Score: 1 / (1 + distance)  — higher is better, within [0, 1]
 *   - Fusion: ranked list is passed through reciprocalRankFusion alongside
 *     the other 4 strategies, so a missing semantic store is never fatal
 *
 * Graceful degradation:
 *   - If the running SQLite binary can't load extensions (canLoadExtensions()
 *     returns false), initVectorStore no-ops and every other function in
 *     this module short-circuits. BM25 + graph + temporal still work.
 *   - If the transformers model can't be loaded (no network, corrupted
 *     cache), generateEmbedding throws — callers should catch and treat
 *     the semantic strategy as empty.
 */

import type { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

import { logger } from "../utils/logger.js";
import { SearchError } from "../utils/errors.js";
import { canLoadExtensions } from "./database.js";
import type { RankedResult } from "./search.js";

// ---------------------------------------------------------------------------
// Model loader (singleton — the extractor is expensive to construct)
// ---------------------------------------------------------------------------

/** Embedding vector dimensionality for all-MiniLM-L6-v2. */
export const EMBEDDING_DIM = 384;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- transformers has no static types
type Extractor = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<Extractor> | null = null;

/**
 * Lazily loads the sentence-transformer pipeline. First call downloads
 * the ONNX model into the local transformers cache (~22MB). Subsequent
 * calls return the same promise.
 */
async function getExtractor(): Promise<Extractor> {
  if (extractorPromise === null) {
    extractorPromise = (async () => {
      logger.info("Loading embedding model", { model: MODEL_ID });
      const transformers = await import("@xenova/transformers");
      const pipeline = transformers.pipeline as unknown as (
        task: string,
        model: string,
      ) => Promise<Extractor>;
      const extractor = await pipeline("feature-extraction", MODEL_ID);
      logger.info("Embedding model ready", { model: MODEL_ID });
      return extractor;
    })();
  }
  return extractorPromise;
}

/**
 * Produces a 384-dimensional embedding for arbitrary text.
 *
 * The returned Float32Array is normalised to unit length so that the
 * sqlite-vec default L2 distance is equivalent to cosine distance.
 *
 * @param text - The text to embed. Truncated internally by the
 *   transformer to its max sequence length (512 tokens for MiniLM).
 * @returns A 384-element Float32Array suitable for vec0 insertion.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (text.trim().length === 0) {
    return new Float32Array(EMBEDDING_DIM);
  }
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  // output.data is already a Float32Array of length EMBEDDING_DIM
  return output.data;
}

// ---------------------------------------------------------------------------
// Vector store initialisation
// ---------------------------------------------------------------------------

/**
 * Loads the sqlite-vec extension into the given database and creates the
 * `entry_vectors` virtual table if it doesn't exist.
 *
 * Safe to call repeatedly — CREATE VIRTUAL TABLE is idempotent via
 * IF NOT EXISTS. If the underlying SQLite binary doesn't support
 * extensions, this function logs a warning and returns false.
 *
 * @param db - Open bun:sqlite database handle.
 * @returns True if the vector store is ready, false if unavailable.
 */
export function initVectorStore(db: Database): boolean {
  if (!canLoadExtensions()) {
    logger.warn(
      "Skipping vector store init — extension loading unsupported by current SQLite",
    );
    return false;
  }

  try {
    sqliteVec.load(db);
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS entry_vectors USING vec0(
        entry_id TEXT PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIM}]
      )`,
    );
    logger.info("Vector store ready", { dim: EMBEDDING_DIM });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("initVectorStore failed", { error: msg });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Converts a Float32Array to the raw byte buffer format sqlite-vec expects.
 *
 * vec0 accepts BLOB columns as Uint8Array — we reinterpret the float
 * memory without copying when possible.
 */
function floatsToBlob(embedding: Float32Array): Uint8Array {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new SearchError(
      `embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${embedding.length}`,
    );
  }
  return new Uint8Array(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

/**
 * Embeds a text string and stores the vector under the given entry ID.
 * Replaces any existing vector for that entry (INSERT OR REPLACE).
 *
 * @param db      - Open database with the vector store loaded.
 * @param entryId - Stable entry identifier.
 * @param text    - The text to embed (typically title + content).
 */
export async function embedAndStore(
  db: Database,
  entryId: string,
  text: string,
): Promise<void> {
  if (!canLoadExtensions()) {
    return;
  }
  try {
    const embedding = await generateEmbedding(text);
    const blob = floatsToBlob(embedding);
    db.run(
      "INSERT OR REPLACE INTO entry_vectors (entry_id, embedding) VALUES (?, ?)",
      [entryId, blob],
    );
    logger.debug("Vector stored", { entryId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("embedAndStore failed", { entryId, error: msg });
    throw new SearchError(`embedAndStore failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Read path (Strategy 5: searchByVector)
// ---------------------------------------------------------------------------

interface VectorRow {
  entry_id: string;
  distance: number;
}

/**
 * Semantic search: embeds the query, runs KNN against entry_vectors,
 * and returns ranked results.
 *
 * Filters out archived/stale entries AND respects the personal/team/project
 * scope boundary when a `developerId` is provided — matching the policy
 * used by searchByBM25 for consistency.
 *
 * Score formula: `1 / (1 + distance)` — turns L2 distance into a
 * similarity score where higher is better. Because we normalise
 * embeddings before storing, L2 between unit vectors is a monotonic
 * function of cosine distance.
 *
 * @param db          - Open database with vector store loaded.
 * @param query       - Raw user query string (not yet embedded).
 * @param limit       - Max results to return (default 20).
 * @param developerId - Optional developer ID for personal-scope filtering.
 * @returns Ranked results ordered by descending score. Empty if the
 *   vector store is unavailable or the query embeds to nothing.
 * @throws {SearchError} If the KNN query fails (but NOT if vec is disabled).
 */
export async function searchByVector(
  db: Database,
  query: string,
  limit: number = 20,
  developerId?: string,
): Promise<RankedResult[]> {
  if (!canLoadExtensions()) {
    return [];
  }
  if (query.trim().length === 0) {
    return [];
  }

  try {
    const queryEmbedding = await generateEmbedding(query);
    const blob = floatsToBlob(queryEmbedding);

    // sqlite-vec requires both MATCH and a k constraint in the WHERE clause.
    // Scope + status filtering happens in an outer join against entries.
    const scopeClause =
      developerId !== undefined
        ? "AND (e.scope IN ('team', 'project') OR (e.scope = 'personal' AND e.developer_id = ?))"
        : "AND e.scope IN ('team', 'project')";

    const sql = `
      SELECT v.entry_id AS entry_id, v.distance AS distance
      FROM   entry_vectors v
      JOIN   entries e ON e.id = v.entry_id
      WHERE  v.embedding MATCH ?
        AND  k = ?
        AND  e.status = 'active'
        ${scopeClause}
      ORDER BY v.distance
    `;

    type Params = [Uint8Array, number] | [Uint8Array, number, string];
    const params: Params =
      developerId !== undefined
        ? [blob, limit, developerId]
        : [blob, limit];

    const rows = db.query<VectorRow, Params>(sql).all(...params);

    return rows.map((row) => ({
      id: row.entry_id,
      score: 1 / (1 + Math.max(0, row.distance)),
      source: "semantic",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("searchByVector failed", { error: msg });
    throw new SearchError(`searchByVector failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Backfill helper (for migrating existing entries into the vector store)
// ---------------------------------------------------------------------------

interface BackfillRow {
  id: string;
  title: string;
  content: string;
}

/**
 * Embeds every active entry in the database that doesn't already have
 * a vector stored. Runs sequentially to keep memory and CPU predictable.
 *
 * @param db - Open database with vector store initialised.
 * @returns Count of entries that were embedded by this call.
 */
export async function backfillVectors(db: Database): Promise<number> {
  if (!canLoadExtensions()) {
    logger.warn("Skipping backfill — vector store unavailable");
    return 0;
  }

  const rows = db
    .query<BackfillRow, []>(
      `SELECT e.id AS id, e.title AS title, e.content AS content
       FROM entries e
       LEFT JOIN entry_vectors v ON v.entry_id = e.id
       WHERE e.status = 'active'
         AND v.entry_id IS NULL`,
    )
    .all();

  if (rows.length === 0) {
    return 0;
  }

  logger.info("Backfilling vectors", { count: rows.length });
  for (const row of rows) {
    const text = `${row.title}\n\n${row.content}`;
    await embedAndStore(db, row.id, text);
  }
  logger.info("Backfill complete", { count: rows.length });
  return rows.length;
}
