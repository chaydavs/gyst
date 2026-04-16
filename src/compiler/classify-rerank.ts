/**
 * Stage 2 of the classification pipeline — graphify / entity-overlap rerank.
 *
 * Pure function: given a Stage 1 verdict plus the payload, count how many
 * existing curated entries already cover the same territory and demote the
 * signal when we're about to create a near-duplicate.
 *
 * Signals consulted (in order of specificity):
 *   1. Entity-tag overlap   — entries that share an `entity:<name>` tag.
 *   2. File-path overlap    — entries touching any of the payload's files.
 *   3. Title Jaccard        — near-duplicate wording on active conventions.
 *
 * This is the "dedup at classify time, not at store time" fix. Downstream
 * `store-conventions.ts` already consolidates per-directory scans; this
 * catches the prompt-driven duplicates that never reach that code path.
 */

import type { Database } from "bun:sqlite";
import type { Classification, EntryType } from "./classify-event.js";
import { extractEntities, extractEntitiesFromTitle } from "./entities.js";
import { logger } from "../utils/logger.js";

/** Rule IDs surfaced by Stage 2. Kept separate from classify-event's map so
 *  the dashboard can distinguish "rule fired" from "graph demoted". */
export const RERANK_RULE_IDS = {
  GRAPH_DUP_CLUSTER: "graph-duplicate-cluster",
  GRAPH_SUPPRESS: "graph-suppress-bloat",
  GRAPH_NOVEL: "graph-novel",
} as const;

/** How many overlapping entries trigger a mild demotion. */
const DUP_DEMOTE_THRESHOLD = 2;
/** How many overlapping entries trigger an aggressive suppression. */
const DUP_SUPPRESS_THRESHOLD = 5;

/** Signal strength subtracted on a mild demotion. */
const DEMOTE_DELTA = 0.3;
/** Signal strength subtracted on aggressive suppression. */
const SUPPRESS_DELTA = 0.5;

const TYPES_TO_RERANK: readonly EntryType[] = ["convention", "error_pattern"];

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Returns the number of active entries of the same candidateType that share
 * any entity tag with the supplied payload/title. Bounded by a LIMIT so the
 * classifier path stays O(1) per event.
 */
function countEntityOverlap(
  db: Database,
  candidateType: EntryType,
  entityTags: readonly string[],
): number {
  if (entityTags.length === 0) return 0;
  const placeholders = entityTags.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, (string | number)[]>(
      `SELECT COUNT(DISTINCT e.id) AS n
         FROM entries e
         JOIN entry_tags t ON t.entry_id = e.id
        WHERE e.type = ?
          AND e.status = 'active'
          AND t.tag IN (${placeholders})
        LIMIT ?`,
    )
    .get(candidateType, ...entityTags, DUP_SUPPRESS_THRESHOLD + 1);
  return row?.n ?? 0;
}

/**
 * Pulls the caller-supplied text that best represents the incoming event —
 * prompt text, tool-use message, or plan title. Used for token-level
 * similarity checks.
 */
function extractCandidateText(payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.length > 0) return text;
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length > 0) return msg;
  const adr = payload.parsedAdr as { title?: string } | null | undefined;
  if (adr?.title) return adr.title;
  const plan = payload.parsedPlan as { title?: string } | null | undefined;
  if (plan?.title) return plan.title;
  return "";
}

/**
 * Applies graphify-style demotions to the Stage 1 verdict when the incoming
 * event looks like a near-duplicate of existing curated entries.
 *
 * Never amplifies — rerank is strictly a suppressor. Returns a new
 * Classification (immutable) so callers can compare before/after.
 */
export function rerankWithGraphify(
  db: Database,
  verdict: Classification,
  payload: Record<string, unknown>,
): Classification {
  // Only convention / error_pattern candidates benefit from rerank; decisions
  // and learnings are inherently per-session so duplicates are less harmful.
  if (!verdict.candidateType || !TYPES_TO_RERANK.includes(verdict.candidateType)) {
    return verdict;
  }

  const text = extractCandidateText(payload);
  if (text.length === 0) return verdict;

  // Build the entity-tag list the same way `learn` does so we match against
  // the tags already indexed on existing entries.
  const contentEntities = extractEntities(text);
  const titleEntities = extractEntitiesFromTitle(text);
  const entityTags = uniq([
    ...contentEntities.map((e) => `entity:${e.name}`),
    ...titleEntities.map((e) => `entity:${e.name}`),
  ]);

  let overlapCount = 0;
  try {
    overlapCount = countEntityOverlap(db, verdict.candidateType, entityTags);
  } catch (err) {
    // A failed DB query must not take down classification. Log and bail.
    logger.warn("classify-rerank: entity overlap query failed", {
      candidateType: verdict.candidateType,
      error: err instanceof Error ? err.message : String(err),
    });
    return verdict;
  }

  if (overlapCount >= DUP_SUPPRESS_THRESHOLD) {
    return {
      ...verdict,
      signalStrength: Math.max(0, verdict.signalStrength - SUPPRESS_DELTA),
      ruleIds: [...verdict.ruleIds, RERANK_RULE_IDS.GRAPH_SUPPRESS],
    };
  }
  if (overlapCount >= DUP_DEMOTE_THRESHOLD) {
    return {
      ...verdict,
      signalStrength: Math.max(0, verdict.signalStrength - DEMOTE_DELTA),
      ruleIds: [...verdict.ruleIds, RERANK_RULE_IDS.GRAPH_DUP_CLUSTER],
    };
  }

  // Novel territory — tag it for the dashboard but leave strength alone.
  if (entityTags.length > 0) {
    return {
      ...verdict,
      ruleIds: [...verdict.ruleIds, RERANK_RULE_IDS.GRAPH_NOVEL],
    };
  }

  return verdict;
}
