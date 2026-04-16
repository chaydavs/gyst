/**
 * Stage 1 queue consumer — promotes high-signal events from event_queue
 * into curated `entries`. LLM distillation (Stage 2) is not implemented here
 * and is scoped into a separate plan.
 *
 * Contract:
 *   - Pure bookkeeping: every pending event is marked completed or failed.
 *   - High-signal events (>= threshold) become new entries.
 *   - Low-signal events are discarded (completed, no entry).
 *   - Idempotent per row via event_queue.status transitions.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  getPendingEvents,
  markEventCompleted,
  markEventFailed,
  normaliseHookPayload,
  type EventType,
} from "../store/events.js";
import { classifyEvent, type Classification } from "./classify-event.js";
import { parseError } from "./parsers/error.js";
import { extractContextFromPrompt } from "./parsers/prompt.js";
import { parseAdr } from "./parsers/markdown-adr.js";
import { parsePlanDoc } from "./parsers/markdown-headings.js";

export interface ProcessOptions {
  readonly limit?: number;
  readonly signalThreshold?: number;
}

export interface ProcessReport {
  readonly processed: number;
  readonly entriesCreated: number;
  readonly skipped: number;
  readonly failed: number;
}

const DEFAULT_THRESHOLD = 0.5;

/**
 * Drains up to `limit` pending events; returns a summary report.
 */
export async function processEvents(
  db: Database,
  options: ProcessOptions = {},
): Promise<ProcessReport> {
  const limit = options.limit ?? 50;
  const threshold = options.signalThreshold ?? DEFAULT_THRESHOLD;

  const rows = getPendingEvents(db, limit);
  let entriesCreated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const rawPayload = JSON.parse(row.payload) as Record<string, unknown>;
      // Defence-in-depth: rescue payloads written before the CLI-level
      // normaliser was added (or by external agents that bypass `gyst emit`).
      const normalised = normaliseHookPayload(row.type as string, rawPayload);
      const payload = enrichPayload(row.type as string, normalised);
      // Thread the queue-row session_id into the payload so downstream
      // entry creation can attach it to metadata for dashboard grouping.
      if (row.session_id && !payload.sessionId) {
        payload.sessionId = row.session_id;
      }
      const verdict = classifyEvent({ type: row.type as string, payload });

      if (verdict.signalStrength >= threshold && verdict.candidateType) {
        const created = createEntryFromEvent(db, row.type, payload, verdict);
        if (created) entriesCreated += 1;
        else skipped += 1;
      } else {
        skipped += 1;
      }
      markEventCompleted(db, row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("process-events: row failed", { id: row.id, error: msg });
      try {
        markEventFailed(db, row.id, msg);
      } catch {
        // last-resort — don't let bookkeeping failure crash the batch.
      }
      failed += 1;
    }
  }

  return { processed: rows.length, entriesCreated, skipped, failed };
}

/**
 * Parser-based payload enrichment. Runs BEFORE classify so the verdict can
 * consider structured fields. Keeps the classifier itself pure.
 *
 * - tool_use: parseError() adds error.type/fingerprint/file/line when the
 *   raw error text is structured, enabling fingerprint dedupe downstream.
 * - prompt: extractContextFromPrompt() adds files[] + symbols[] so the
 *   classifier (future C.1 rebalance) can weight code-grounded prompts higher.
 */
function enrichPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (eventType === "tool_use") {
    const error = typeof payload.error === "string" ? payload.error : "";
    if (error.length > 0) {
      const parsed = parseError(error);
      if (parsed) {
        return {
          ...payload,
          parsedError: {
            type: parsed.type,
            message: parsed.message,
            file: parsed.file ?? null,
            line: parsed.line ?? null,
            fingerprint: parsed.fingerprint,
          },
        };
      }
    }
    return payload;
  }
  if (eventType === "prompt") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text.length > 0) {
      const ctx = extractContextFromPrompt(text);
      return { ...payload, promptContext: ctx };
    }
    return payload;
  }
  if (eventType === "plan_added") {
    const path = typeof payload.path === "string" ? payload.path : "";
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content.length === 0) return payload;
    // ADRs: decisions/NNN-*.md use parseAdr. Everything else under
    // docs/plans/ or docs/superpowers/plans/ uses parsePlanDoc.
    if (isAdrPath(path)) {
      const adr = parseAdr(path, content);
      if (adr) return { ...payload, parsedAdr: adr };
    } else {
      const plan = parsePlanDoc(content);
      if (plan) return { ...payload, parsedPlan: plan };
    }
    return payload;
  }
  return payload;
}

/**
 * Creates a new entry row from the classified event.
 * Returns false when dedupe suppressed creation (error_pattern fingerprint hit).
 *
 * Phase D.1: fingerprint dedupe — on error_pattern with a known fingerprint,
 * increment source_count + bump last_confirmed instead of inserting.
 * Phase D.2: session_id is carried into metadata JSON so the dashboard can
 * group entries per session.
 */
function createEntryFromEvent(
  db: Database,
  eventType: EventType | string,
  payload: Record<string, unknown>,
  verdict: Classification,
): boolean {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scope = verdict.scopeHint === "uncertain" ? "personal" : verdict.scopeHint;

  const title = deriveTitle(eventType, payload);
  const content = deriveContent(eventType, payload);
  const developerId =
    typeof payload.developerId === "string" ? payload.developerId : null;

  // Fingerprint dedupe for error_pattern — avoids the "same tsc error
  // writes a new row every session" problem that would otherwise swamp
  // the KB with duplicates.
  const parsedError = (payload.parsedError ?? null) as
    | { fingerprint: string; type: string; file: string | null }
    | null;
  const errorSignature =
    verdict.candidateType === "error_pattern" && parsedError
      ? parsedError.fingerprint
      : null;

  if (errorSignature) {
    const existing = db
      .query<{ id: string; source_count: number }, [string]>(
        "SELECT id, source_count FROM entries WHERE error_signature = ? AND status = 'active' LIMIT 1",
      )
      .get(errorSignature);
    if (existing) {
      db.run(
        "UPDATE entries SET source_count = source_count + 1, last_confirmed = ? WHERE id = ?",
        [now, existing.id],
      );
      logger.debug("process-events: deduped error_pattern", {
        fingerprint: errorSignature,
        existingId: existing.id,
      });
      return false;
    }
  }

  const metadata = buildMetadata(payload);
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  const filePath =
    parsedError?.file ??
    (typeof payload.cwd === "string" ? null : null);

  db.run(
    `INSERT INTO entries
       (id, type, title, content, file_path, error_signature, confidence, source_count, source_tool,
        created_at, last_confirmed, status, scope, developer_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      verdict.candidateType!,
      title,
      content,
      filePath,
      errorSignature,
      verdict.signalStrength,
      `event:${eventType}`,
      now,
      now,
      scope,
      developerId,
      metadataJson,
    ],
  );
  return true;
}

/** True when a file path points to an Architecture Decision Record. */
export function isAdrPath(path: string): boolean {
  return path.startsWith("decisions/") || path.includes("/decisions/");
}

function buildMetadata(payload: Record<string, unknown>): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  if (typeof payload.sessionId === "string" && payload.sessionId.length > 0) {
    meta.sessionId = payload.sessionId;
  }
  if (payload.promptContext && typeof payload.promptContext === "object") {
    meta.promptContext = payload.promptContext;
  }
  if (payload.parsedError && typeof payload.parsedError === "object") {
    meta.parsedError = payload.parsedError;
  }
  if (payload.parsedAdr && typeof payload.parsedAdr === "object") {
    meta.parsedAdr = payload.parsedAdr;
  }
  if (payload.parsedPlan && typeof payload.parsedPlan === "object") {
    meta.parsedPlan = payload.parsedPlan;
  }
  if (typeof payload.path === "string" && payload.path.length > 0) {
    meta.path = payload.path;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function deriveTitle(eventType: string, payload: Record<string, unknown>): string {
  // ADR / plan parsed on enrichment — use the structured title.
  const adr = payload.parsedAdr as { title?: string } | null | undefined;
  if (adr?.title) return truncateTitle(adr.title);
  const plan = payload.parsedPlan as { title?: string } | null | undefined;
  if (plan?.title) return truncateTitle(plan.title);

  const text = typeof payload.text === "string" ? payload.text : "";
  const msg = typeof payload.message === "string" ? payload.message : "";
  const raw = text || msg || `${eventType} event`;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return truncateTitle(oneLine);
}

function deriveContent(_eventType: string, payload: Record<string, unknown>): string {
  // Prefer the parser's summary for plan_added — compact, signal-rich.
  const adr = payload.parsedAdr as { summary?: string } | null | undefined;
  if (adr?.summary) return adr.summary;
  const plan = payload.parsedPlan as { summary?: string } | null | undefined;
  if (plan?.summary) return plan.summary;

  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.length > 0) return text;
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length > 0) return msg;
  return JSON.stringify(payload);
}

function truncateTitle(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 97)}...`;
}
