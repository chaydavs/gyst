/**
 * Dormant scheduling for Stage 2 distillation (Phase C.3).
 *
 * Distillation is expensive (LLM round-trip per session) and *optional* —
 * without ANTHROPIC_API_KEY configured, `distillEvents` short-circuits to
 * a no-op. These helpers wrap the scheduling policy so callers in the hot
 * path (MCP event loop, session_end hook) never have to know the rules:
 *
 *   1. **On session_end** — distill only that session's events, fire-and-forget.
 *      Runs synchronously from the caller's perspective but wraps errors so a
 *      misbehaving LLM never breaks the hook.
 *
 *   2. **Nightly (~every 24h)** — distill any remaining completed events in
 *      batches. Guarded by an in-memory `lastNightlyAt` timestamp so repeated
 *      poll ticks don't duplicate the work. Restart resets the clock (worst
 *      case: one extra run, which is now idempotent because distill.ts skips
 *      already-distilled events).
 *
 * Both are strictly non-blocking — any thrown error is logged and swallowed.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { distillEvents } from "./distill.js";

/** Milliseconds in 24 hours. */
const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Default cap per nightly batch — prevents a single run from stalling on a huge backlog. */
const NIGHTLY_BATCH_LIMIT = 500;

/** Default cap per session_end run — one session rarely produces >50 events. */
const SESSION_END_BATCH_LIMIT = 50;

/**
 * In-memory last-run timestamp. Module-level so every caller shares it
 * within a single process; reset on restart (safe, see file docstring).
 */
let lastNightlyAt = 0;

/**
 * Exposed for tests only. Resets the nightly guard so an isolated test
 * starts from a known state.
 */
export function __resetDistillScheduler(): void {
  lastNightlyAt = 0;
}

/**
 * Runs session-scoped distillation for the session that just ended.
 *
 * If `sessionId` is missing or falsy, this is a no-op — we never want to
 * distill the entire event queue from a single session_end hook.
 *
 * Returns a Promise so callers can choose to await (tests) or fire-and-forget
 * (production hooks). Any error is caught and logged; the returned Promise
 * always resolves.
 */
export async function triggerSessionDistill(
  db: Database,
  sessionId: string | null | undefined,
): Promise<void> {
  if (!sessionId) {
    logger.debug("distill-scheduler: no sessionId on session_end, skipping");
    return;
  }
  try {
    const report = await distillEvents(db, {
      sessionId,
      limit: SESSION_END_BATCH_LIMIT,
    });
    if (report.entriesCreated > 0 || report.eventsProcessed > 0) {
      logger.info("distill-scheduler: session_end distill", {
        sessionId,
        sessionsProcessed: report.sessionsProcessed,
        eventsProcessed: report.eventsProcessed,
        entriesCreated: report.entriesCreated,
      });
    }
  } catch (err) {
    logger.error("distill-scheduler: session_end distill failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Runs the nightly batch if more than `NIGHTLY_INTERVAL_MS` has elapsed
 * since the last successful invocation. Cheap to call on every poll tick —
 * the guard short-circuits almost always.
 *
 * @param db - Gyst SQLite handle.
 * @param now - Clock injection seam for tests; defaults to `Date.now()`.
 */
export async function maybeRunNightlyDistill(
  db: Database,
  now: number = Date.now(),
): Promise<void> {
  if (now - lastNightlyAt < NIGHTLY_INTERVAL_MS) {
    return;
  }
  // Set the guard *before* the await so concurrent poll ticks don't all
  // race into the LLM call. If distillEvents throws, we still treat the
  // attempt as "recent" — retrying a failing LLM every 5s would be worse.
  lastNightlyAt = now;
  try {
    const report = await distillEvents(db, { limit: NIGHTLY_BATCH_LIMIT });
    if (report.entriesCreated > 0 || report.eventsProcessed > 0) {
      logger.info("distill-scheduler: nightly distill", { ...report });
    } else {
      logger.debug("distill-scheduler: nightly distill (no new events)");
    }
  } catch (err) {
    logger.error("distill-scheduler: nightly distill failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
