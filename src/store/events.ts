import { Database } from "bun:sqlite";
import { withRetry } from "./database.js";

/** Valid universal hook event types */
export type EventType =
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "prompt"
  | "pre_tool_use"
  | "tool_use"
  | "commit"
  | "pull"
  | "file_change"
  | "md_change"
  | "md_changed"
  | "tool_failure"
  | "kb_miss_signal"
  | "drift_snapshot"
  | "plan_added"
  | "error";

/**
 * Standardised event payload.
 * Can contain any agent-specific metadata.
 */
export interface EventPayload {
  agent?: string;
  sessionId?: string;
  developerId?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Inserts an event into the fire-and-forget queue.
 * This function is designed to be extremely fast (< 50ms) to avoid
 * blocking CLI lifecycle hooks.
 */
export function emitEvent(
  db: Database,
  type: EventType,
  payload: EventPayload,
): void {
  const sessionId = payload.sessionId ?? null;
  withRetry(() => {
    db.run(
      "INSERT INTO event_queue (type, payload, session_id) VALUES (?, ?, ?)",
      [type, JSON.stringify(payload), sessionId],
    );
  }, 3, 50); // Aggressive retry with short delay for hooks
}

/**
 * Retrieves the next batch of pending events for processing.
 * Includes session_id so downstream promotion can group entries per session.
 */
export function getPendingEvents(
  db: Database,
  limit: number = 50,
): { id: number; type: EventType; payload: string; session_id: string | null }[] {
  return db
    .query<
      { id: number; type: EventType; payload: string; session_id: string | null },
      [number]
    >(
      "SELECT id, type, payload, session_id FROM event_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
    )
    .all(limit);
}

/**
 * Marks an event as completed.
 */
export function markEventCompleted(db: Database, id: number): void {
  db.run(
    "UPDATE event_queue SET status = 'completed', processed_at = datetime('now') WHERE id = ?",
    [id],
  );
}

/**
 * Marks an event as failed with an error message.
 */
export function markEventFailed(db: Database, id: number, error: string): void {
  db.run(
    "UPDATE event_queue SET status = 'failed', error = ?, processed_at = datetime('now') WHERE id = ?",
    [error, id],
  );
}

/**
 * Normalises a raw Claude Code hook JSON into the payload shape that
 * classify-event.ts and emitEvent expect. Claude Code uses snake_case
 * (session_id, prompt, tool_name, tool_response) while the internal
 * pipeline reads camelCase (sessionId, text, tool, error). This function
 * bridges both naming conventions so direct-hook configs AND plugin
 * scripts both produce the same canonical payload.
 *
 * Pure function. Idempotent — calling it twice yields the same result.
 */
export function normaliseHookPayload(
  type: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (typeof raw.session_id === "string" && typeof raw.sessionId !== "string") {
    out.sessionId = raw.session_id;
  }
  if (type === "prompt") {
    if (typeof raw.prompt === "string" && typeof raw.text !== "string") {
      out.text = raw.prompt;
    }
  }
  if (type === "tool_use") {
    if (typeof raw.tool_name === "string" && typeof raw.tool !== "string") {
      out.tool = raw.tool_name;
    }
    if (typeof raw.error !== "string") {
      const resp = raw.tool_response;
      if (resp && typeof resp === "object") {
        const r = resp as {
          is_error?: unknown;
          content?: unknown;
          error?: unknown;
          stderr?: unknown;
        };
        if (r.is_error === true && typeof r.content === "string") {
          out.error = r.content;
        } else if (typeof r.error === "string") {
          out.error = r.error;
        } else if (typeof r.stderr === "string" && r.stderr.length > 0) {
          out.error = r.stderr;
        }
      }
    }
  }
  return out;
}
