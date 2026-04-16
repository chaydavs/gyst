import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { initDatabase } from "../../src/store/database.js";
import { emitEvent } from "../../src/store/events.js";
// @ts-ignore - file does not exist yet
import { processEvents } from "../../src/compiler/process-events.js";

describe("processEvents", () => {
  let db: Database;
  const dbPath = join(import.meta.dir, "test-process-events.db");

  beforeEach(() => {
    db = initDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  test("promotes high-signal events to entries and marks them completed", async () => {
    // 1. Setup events
    // High signal: Convention
    emitEvent(db, "prompt", {
      text: "we always use camelCase for identifiers",
      developerId: "dev-123"
    });

    // Low signal: Casual chat
    emitEvent(db, "prompt", {
      text: "hello world"
    });

    // 2. Process
    const report = await processEvents(db);

    // 3. Assertions
    expect(report.processed).toBe(2);
    expect(report.entriesCreated).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);

    // Check entry was created
    const entries = db.query("SELECT * FROM entries").all();
    expect(entries.length).toBe(1);
    const entry = entries[0] as any;
    expect(entry.type).toBe("convention");
    expect(entry.developer_id).toBe("dev-123");
    expect(entry.title).toContain("camelCase");

    // Check event queue status
    const pendingCount = db.query("SELECT COUNT(*) as count FROM event_queue WHERE status = 'pending'").get() as any;
    expect(pendingCount.count).toBe(0);

    const completedCount = db.query("SELECT COUNT(*) as count FROM event_queue WHERE status = 'completed'").get() as any;
    expect(completedCount.count).toBe(2);
  });

  test("error_pattern dedupe: same fingerprint increments source_count instead of duplicating", async () => {
    // Two tool_use events carrying the same TypeScript error. After processing,
    // we want one entry with source_count=2, not two separate rows.
    const tscError = "src/foo.ts:12:34 - error TS2322: Type 'string' is not assignable to type 'number'.";
    emitEvent(db, "tool_use", { tool: "Bash", error: tscError });
    emitEvent(db, "tool_use", { tool: "Bash", error: tscError });

    const report = await processEvents(db);
    expect(report.processed).toBe(2);
    expect(report.entriesCreated).toBe(1);
    expect(report.skipped).toBe(1);

    const entries = db.query("SELECT * FROM entries WHERE type = 'error_pattern'").all() as any[];
    expect(entries.length).toBe(1);
    expect(entries[0].source_count).toBe(2);
    expect(entries[0].error_signature).toBeTruthy();
  });

  test("session_id from event_queue is threaded into entries.metadata", async () => {
    emitEvent(db, "prompt", {
      text: "we always use camelCase for identifiers",
      sessionId: "sess-abc-123",
    });
    await processEvents(db);

    const entry = db.query("SELECT metadata FROM entries LIMIT 1").get() as any;
    expect(entry).toBeTruthy();
    expect(entry.metadata).toBeTruthy();
    const meta = JSON.parse(entry.metadata);
    expect(meta.sessionId).toBe("sess-abc-123");
  });

  test("prompt enrichment: extracted files + symbols attached to metadata", async () => {
    emitEvent(db, "prompt", {
      text: "debugging auth flow in src/auth/middleware.ts where `handleSessionTimeout` misfires",
    });
    await processEvents(db);

    const entry = db.query("SELECT metadata FROM entries LIMIT 1").get() as any;
    expect(entry).toBeTruthy();
    const meta = JSON.parse(entry.metadata);
    expect(meta.promptContext).toBeDefined();
    expect(meta.promptContext.files).toContain("src/auth/middleware.ts");
    expect(meta.promptContext.symbols).toContain("handleSessionTimeout");
  });

  test("plan_added: ADR markdown becomes a decision entry with parsed title + summary", async () => {
    const adrMd = [
      "# Decision: Switch session storage to Redis",
      "",
      "Date: 2026-05-01",
      "Status: Accepted",
      "",
      "## Context",
      "",
      "SQLite sessions contend with writes under load.",
      "",
      "## Decision",
      "",
      "We chose Redis for low-latency session storage.",
    ].join("\n");

    emitEvent(db, "plan_added", {
      path: "decisions/042-redis-sessions.md",
      content: adrMd,
      sessionId: "sess-plan-1",
    });

    const report = await processEvents(db);
    expect(report.entriesCreated).toBe(1);

    const entry = db.query("SELECT * FROM entries WHERE type = 'decision'").get() as any;
    expect(entry).toBeTruthy();
    expect(entry.title).toBe("Switch session storage to Redis");
    expect(entry.content).toContain("Redis");
    const meta = JSON.parse(entry.metadata);
    expect(meta.parsedAdr.number).toBe(42);
    expect(meta.parsedAdr.status).toBe("Accepted");
    expect(meta.sessionId).toBe("sess-plan-1");
  });

  test("plan_added: non-decisions path routes to learning via plan parser", async () => {
    const planMd = [
      "# Rollout Plan: Quality Gate V2",
      "",
      "**Goal:** Land V2 by EOQ",
      "",
      "## Tasks",
      "",
      "- [x] design",
      "- [ ] implement",
    ].join("\n");

    emitEvent(db, "plan_added", {
      path: "docs/superpowers/plans/2026-05-quality-v2.md",
      content: planMd,
    });

    const report = await processEvents(db);
    expect(report.entriesCreated).toBe(1);

    const entry = db.query("SELECT * FROM entries WHERE type = 'learning'").get() as any;
    expect(entry).toBeTruthy();
    expect(entry.title).toBe("Rollout Plan: Quality Gate V2");
    const meta = JSON.parse(entry.metadata);
    expect(meta.parsedPlan.tasks.total).toBe(2);
    expect(meta.parsedPlan.tasks.done).toBe(1);
  });

  test("md_change is recorded but low-signal — no entry created", async () => {
    emitEvent(db, "md_change", { path: "README.md" });
    const report = await processEvents(db);
    expect(report.entriesCreated).toBe(0);
    expect(report.skipped).toBe(1);
  });

  test("handles processing failures by marking events as failed", async () => {
    // Insert a malformed payload manually to trigger an error in JSON.parse or similar
    db.run(
      "INSERT INTO event_queue (type, payload, status) VALUES (?, ?, ?)",
      ["prompt", "not-json", "pending"]
    );

    const report = await processEvents(db);

    expect(report.processed).toBe(1);
    expect(report.failed).toBe(1);

    const failedEvent = db.query("SELECT * FROM event_queue WHERE status = 'failed'").get() as any;
    expect(failedEvent).toBeDefined();
    expect(failedEvent.error).toBeDefined();
  });
});
