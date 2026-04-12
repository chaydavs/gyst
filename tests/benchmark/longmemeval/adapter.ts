/**
 * LongMemEval adapter for Gyst.
 *
 * Converts the benchmark's haystack sessions into Gyst knowledge entries,
 * runs recall against the benchmark questions, and scores retrieval
 * results against the ground-truth `answer_session_ids`.
 *
 * Data format (see tests/benchmark/longmemeval/data/longmemeval_s.json):
 *   - 500 question objects
 *   - Each with `haystack_sessions` (array of ~53 conversation arrays)
 *   - Each haystack session is an array of { role, content } turns
 *   - `haystack_session_ids` parallels haystack_sessions
 *   - `haystack_dates` parallels haystack_sessions (format: "2023/05/20 (Sat) 02:21")
 *   - `answer_session_ids` lists the session IDs containing the ground truth
 *
 * Scoring: Option B (retrieval-only). A question is a hit when any
 * entry in the top-5 recall results maps back to a session ID in
 * `answer_session_ids`. Same pattern as MRR@5 / Recall@5 / Hit Rate in
 * the existing retrieval-eval harness.
 */

import type { Database } from "bun:sqlite";
import { insertEntry } from "../../../src/store/database.js";
import { searchByBM25, searchByGraph, searchByTemporal, reciprocalRankFusion } from "../../../src/store/search.js";
import { searchByVector } from "../../../src/store/embeddings.js";

// ---------------------------------------------------------------------------
// LongMemEval types
// ---------------------------------------------------------------------------

export interface LmeTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LmeQuestion {
  readonly question_id: string;
  readonly question_type:
    | "single-session-user"
    | "single-session-assistant"
    | "single-session-preference"
    | "multi-session"
    | "temporal-reasoning"
    | "knowledge-update";
  readonly question: string;
  readonly question_date: string;
  readonly answer: string;
  readonly answer_session_ids: readonly string[];
  readonly haystack_dates: readonly string[];
  readonly haystack_session_ids: readonly string[];
  readonly haystack_sessions: readonly (readonly LmeTurn[])[];
}

// ---------------------------------------------------------------------------
// Session → entry conversion
// ---------------------------------------------------------------------------

/**
 * Parses a benchmark date string like "2023/05/20 (Sat) 02:21" into an
 * ISO-8601 timestamp. Returns null on parse failure so the caller can
 * fall back to now.
 */
function parseLmeDate(lme: string): string | null {
  // "2023/05/20 (Sat) 02:21" → "2023-05-20T02:21:00Z"
  const match = lme.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*\([^)]+\)\s*(\d{2}):(\d{2})/);
  if (match === null) return null;
  const [, y, m, d, hh, mm] = match;
  return `${y}-${m}-${d}T${hh}:${mm}:00Z`;
}

/**
 * Converts a haystack session (array of turns) into a single Gyst
 * knowledge entry. One entry per session — turn-level extraction would
 * blow up the corpus 10x.
 */
function sessionToEntry(
  sessionId: string,
  sessionIdx: number,
  turns: readonly LmeTurn[],
  lmeDate: string,
): {
  id: string;
  title: string;
  content: string;
  lastConfirmed: string;
  createdAt: string;
} {
  // Title: first user turn, truncated so zod's 200-char limit doesn't reject.
  const firstUser = turns.find((t) => t.role === "user");
  const titleRaw = firstUser?.content ?? `Session ${sessionIdx}`;
  const title = titleRaw.length > 180 ? titleRaw.slice(0, 177) + "..." : titleRaw;

  // Content: all turns concatenated, role prefixes stripped for cleaner
  // indexing. The FTS5 BM25 tokenizer handles long text fine.
  const content = turns.map((t) => t.content).join("\n\n");

  const isoDate = parseLmeDate(lmeDate) ?? new Date().toISOString();
  return {
    id: sessionId,
    title,
    content,
    lastConfirmed: isoDate,
    createdAt: isoDate,
  };
}

/**
 * Ingests every session in a question's haystack into the database as
 * `learning`-type entries. Returns the number of entries inserted.
 *
 * The session ID becomes the entry ID so that downstream scoring can map
 * ranked result IDs directly back to the ground-truth answer_session_ids
 * set without a separate lookup table.
 */
export function ingestHaystack(db: Database, question: LmeQuestion): number {
  const n = Math.min(
    question.haystack_sessions.length,
    question.haystack_session_ids.length,
    question.haystack_dates.length,
  );

  let count = 0;
  for (let i = 0; i < n; i++) {
    const turns = question.haystack_sessions[i]!;
    const sessionId = question.haystack_session_ids[i]!;
    const date = question.haystack_dates[i]!;
    const entry = sessionToEntry(sessionId, i, turns, date);

    // extract.ts requires content.length >= 10. Skip empty sessions.
    if (entry.content.trim().length < 10) {
      continue;
    }

    // Safety cap so pathological sessions don't dominate memory.
    const safeContent =
      entry.content.length > 50_000
        ? entry.content.slice(0, 50_000) + "\n\n[truncated]"
        : entry.content;

    try {
      insertEntry(db, {
        id: entry.id,
        type: "learning",
        title: entry.title,
        content: safeContent,
        files: [],
        tags: [],
        confidence: 0.8,
        sourceCount: 1,
        createdAt: entry.createdAt,
        lastConfirmed: entry.lastConfirmed,
        status: "active",
      });
      count += 1;
    } catch {
      // Per-question fresh DB means dup IDs shouldn't happen; swallow just
      // in case a dataset has accidental duplicates.
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface RetrievalOptions {
  /** Skip the semantic vector strategy for faster iteration. */
  readonly fast: boolean;
  /** How many top results to consider. Default 5 matches LongMemEval convention. */
  readonly topK: number;
}

/**
 * Runs the Gyst retrieval pipeline for a single benchmark question.
 *
 * Skipped strategies (no signal in the benchmark's conversational data):
 *   - searchByFilePath (sessions carry no file paths)
 *
 * Active strategies:
 *   - searchByBM25        (FTS5 with query expansion)
 *   - searchByGraph       (graph walk — mostly empty since there are no tags/files)
 *   - searchByTemporal    (conditional — fires only when question contains time phrases)
 *   - searchByVector      (semantic; skipped when --fast)
 *
 * Fused via RRF and returned as a list of session IDs in rank order.
 */
export async function retrieveTopK(
  db: Database,
  question: LmeQuestion,
  options: RetrievalOptions,
): Promise<string[]> {
  const query = question.question;

  // Each strategy is wrapped so a single failure degrades to zero results
  // instead of crashing the whole run. This matters for a 500-question
  // benchmark where edge-case queries would otherwise abort the whole run.
  let bm25: { id: string; score: number; source: string }[] = [];
  let graph: { id: string; score: number; source: string }[] = [];
  let temporal: { id: string; score: number; source: string }[] = [];
  let vector: { id: string; score: number; source: string }[] = [];

  try {
    bm25 = searchByBM25(db, query);
  } catch {
    bm25 = [];
  }
  try {
    graph = searchByGraph(db, query);
  } catch {
    graph = [];
  }
  try {
    temporal = searchByTemporal(db, query);
  } catch {
    temporal = [];
  }
  if (!options.fast) {
    try {
      vector = await searchByVector(db, query, 20);
    } catch {
      vector = [];
    }
  }

  const fused = reciprocalRankFusion([bm25, graph, temporal, vector]);
  return fused.slice(0, options.topK).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Scoring (Option B: retrieval-only)
// ---------------------------------------------------------------------------

export interface QuestionResult {
  readonly questionId: string;
  readonly questionType: string;
  readonly question: string;
  readonly groundTruth: readonly string[];
  readonly retrieved: readonly string[];
  readonly hit: boolean;
  readonly reciprocalRank: number;
  readonly recallAtK: number;
  readonly ingestedCount: number;
  readonly retrievalMs: number;
}

/**
 * Scores a single retrieval run against the ground truth.
 *
 * Metrics (standard IR):
 *   hit            — any ground-truth session in top K
 *   reciprocalRank — 1/rank of the FIRST ground-truth session in retrieved
 *                    (0 if none found)
 *   recallAtK      — fraction of ground-truth sessions recovered in top K
 */
export function scoreRetrieval(
  retrieved: readonly string[],
  groundTruth: readonly string[],
): { hit: boolean; reciprocalRank: number; recallAtK: number } {
  const truthSet = new Set(groundTruth);
  let firstHitRank = 0;
  let hitCount = 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (truthSet.has(retrieved[i]!)) {
      hitCount += 1;
      if (firstHitRank === 0) {
        firstHitRank = i + 1; // 1-indexed
      }
    }
  }
  return {
    hit: hitCount > 0,
    reciprocalRank: firstHitRank > 0 ? 1 / firstHitRank : 0,
    recallAtK: groundTruth.length > 0 ? hitCount / groundTruth.length : 0,
  };
}
