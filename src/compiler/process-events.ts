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
  type EventType,
} from "../store/events.js";
import { classifyEvent, type Classification } from "./classify-event.js";

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
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const verdict = classifyEvent({ type: row.type as string, payload });

      if (verdict.signalStrength >= threshold && verdict.candidateType) {
        createEntryFromEvent(db, row.type, payload, verdict);
        entriesCreated += 1;
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

function createEntryFromEvent(
  db: Database,
  eventType: EventType | string,
  payload: Record<string, unknown>,
  verdict: Classification,
): void {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scope = verdict.scopeHint === "uncertain" ? "personal" : verdict.scopeHint;

  const title = deriveTitle(eventType, payload);
  const content = deriveContent(eventType, payload);
  const developerId =
    typeof payload.developerId === "string" ? payload.developerId : null;

  db.run(
    `INSERT INTO entries
       (id, type, title, content, confidence, source_count, source_tool,
        created_at, last_confirmed, status, scope, developer_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      verdict.candidateType!,
      title,
      content,
      verdict.signalStrength,
      `event:${eventType}`,
      now,
      now,
      scope,
      developerId,
    ],
  );
}

function deriveTitle(eventType: string, payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  const msg = typeof payload.message === "string" ? payload.message : "";
  const raw = text || msg || `${eventType} event`;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 97)}...`;
}

function deriveContent(_eventType: string, payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.length > 0) return text;
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length > 0) return msg;
  return JSON.stringify(payload);
}
