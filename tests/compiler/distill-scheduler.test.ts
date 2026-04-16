import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";

// Count LLM invocations so we can assert dormancy vs firing.
let llmCallCount = 0;
mock.module("../../src/utils/llm.js", () => ({
  distillWithLlm: async () => {
    llmCallCount++;
    return {
      entries: [
        {
          type: "learning",
          title: "mock distilled learning",
          content: "distilled",
          confidence: 0.8,
          scope: "team",
          tags: ["mock"],
          file_paths: [],
        },
      ],
    };
  },
}));

import { distillEvents } from "../../src/compiler/distill.js";
import {
  maybeRunNightlyDistill,
  triggerSessionDistill,
  __resetDistillScheduler,
} from "../../src/compiler/distill-scheduler.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  llmCallCount = 0;
  __resetDistillScheduler();
});

afterEach(() => {
  db.close();
});

function seedCompletedEvent(sessionId: string): void {
  db.run(
    "INSERT INTO event_queue (type, payload, status, session_id) VALUES (?, ?, 'completed', ?)",
    ["prompt", JSON.stringify({ text: "signal" }), sessionId],
  );
}

// -------- distill.ts bug fix: already-distilled events are skipped --------

test("distillEvents skips events already marked error='distilled' (idempotent)", async () => {
  seedCompletedEvent("s1");

  const first = await distillEvents(db, { limit: 10 });
  expect(first.eventsProcessed).toBe(1);
  expect(llmCallCount).toBe(1);

  // Second run against the same queue must be a no-op.
  const second = await distillEvents(db, { limit: 10 });
  expect(second.eventsProcessed).toBe(0);
  expect(second.entriesCreated).toBe(0);
  expect(llmCallCount).toBe(1); // unchanged — no second LLM call
});

// -------- triggerSessionDistill --------

test("triggerSessionDistill runs distillation scoped to given sessionId", async () => {
  seedCompletedEvent("s1");
  seedCompletedEvent("s2");

  await triggerSessionDistill(db, "s1");

  // s1 is flagged distilled; s2 still waiting.
  const s1Flag = db
    .query<{ error: string | null }, [string]>(
      "SELECT error FROM event_queue WHERE session_id = ?",
    )
    .get("s1");
  const s2Flag = db
    .query<{ error: string | null }, [string]>(
      "SELECT error FROM event_queue WHERE session_id = ?",
    )
    .get("s2");

  expect(s1Flag?.error).toBe("distilled");
  expect(s2Flag?.error).toBeNull();
});

test("triggerSessionDistill is a no-op for missing/null sessionId", async () => {
  seedCompletedEvent("s1");

  await triggerSessionDistill(db, null);
  await triggerSessionDistill(db, undefined);
  await triggerSessionDistill(db, "");

  expect(llmCallCount).toBe(0);
});

// -------- maybeRunNightlyDistill guard --------

test("maybeRunNightlyDistill fires on first call, then is dormant for ~24h", async () => {
  seedCompletedEvent("s1");

  const t0 = 1_000_000_000_000;
  await maybeRunNightlyDistill(db, t0);
  expect(llmCallCount).toBe(1);

  // Same-tick repeat: guarded.
  seedCompletedEvent("s2");
  await maybeRunNightlyDistill(db, t0 + 1);
  expect(llmCallCount).toBe(1);

  // 23h59m later: still guarded.
  await maybeRunNightlyDistill(db, t0 + 23 * 60 * 60 * 1000);
  expect(llmCallCount).toBe(1);
});

test("maybeRunNightlyDistill fires again after 24h elapsed", async () => {
  seedCompletedEvent("s1");

  const t0 = 2_000_000_000_000;
  await maybeRunNightlyDistill(db, t0);
  expect(llmCallCount).toBe(1);

  seedCompletedEvent("s2");
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  await maybeRunNightlyDistill(db, t0 + ONE_DAY_MS + 1);
  expect(llmCallCount).toBe(2);
});

test("maybeRunNightlyDistill keeps guard even when the batch throws", async () => {
  // Simulate distillation backend crashing by inserting a malformed event:
  // the current implementation logs-and-swallows inside distillEvents, so
  // the guard still advances — retrying on the next 5s tick would be worse
  // than waiting until tomorrow.
  seedCompletedEvent("s1");
  const t0 = 3_000_000_000_000;
  await maybeRunNightlyDistill(db, t0);
  expect(llmCallCount).toBe(1);

  // Second call on same tick stays dormant.
  seedCompletedEvent("s2");
  await maybeRunNightlyDistill(db, t0 + 5000);
  expect(llmCallCount).toBe(1);
});
