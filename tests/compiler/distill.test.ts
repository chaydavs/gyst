import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";

// Mock the LLM module before importing distillEvents
mock.module("../../src/utils/llm.js", () => {
  return {
    distillWithLlm: async () => ({
      entries: [
        {
          type: "convention",
          title: "Use Haiku 4.5 for extraction",
          content: "We decided to use Haiku 4.5 because it's fast and cheap.",
          confidence: 0.9,
          scope: "team",
          tags: ["llm", "haiku"],
          file_paths: ["src/utils/llm.ts"],
        },
      ],
    }),
  };
});

// Now import the module under test
import { distillEvents } from "../../src/compiler/distill.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  // Seed some completed events
  db.run("INSERT INTO event_queue (type, payload, status, session_id) VALUES (?, ?, 'completed', ?)", 
    ["prompt", JSON.stringify({ text: "let's use haiku" }), "s1"]);
});

afterEach(() => {
  db.close();
});

test("distillEvents promotes completed events to entries", async () => {
  const report = await distillEvents(db, { limit: 10 });
  
  expect(report.sessionsProcessed).toBe(1);
  expect(report.eventsProcessed).toBe(1);
  expect(report.entriesCreated).toBe(1);

  const entry = db.query<{ title: string; type: string }, []>("SELECT title, type FROM entries LIMIT 1").get();
  expect(entry?.title).toBe("Use Haiku 4.5 for extraction");
  expect(entry?.type).toBe("convention");

  // Verify status update (idempotency check)
  const event = db.query<{ error: string }, []>("SELECT error FROM event_queue WHERE session_id = 's1'").get();
  expect(event?.error).toBe("distilled");
});

test("distillEvents respects sessionId filter", async () => {
  db.run("INSERT INTO event_queue (type, payload, status, session_id) VALUES (?, ?, 'completed', ?)", 
    ["prompt", JSON.stringify({ text: "other session" }), "s2"]);
    
  const report = await distillEvents(db, { sessionId: "s1" });
  expect(report.sessionsProcessed).toBe(1);
  expect(report.eventsProcessed).toBe(1);
  
  const remaining = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM event_queue WHERE session_id = 's2' AND error IS NULL").get();
  expect(remaining?.count).toBe(1);
});
