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
