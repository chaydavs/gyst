import { Database } from "bun:sqlite";
import { withRetry } from "./database.js";

/** Valid universal hook event types */
export type EventType =
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "prompt"
  | "tool_use"
  | "commit"
  | "pull"
  | "file_change"
  | "md_change"
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
