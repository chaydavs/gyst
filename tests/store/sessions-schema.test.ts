/**
 * Tests for Task 3: Sessions schema and event session_id.
 */

import { describe, test, expect } from "bun:test";
import { initDatabase } from "../../src/store/database.js";
import { emitEvent } from "../../src/store/events.js";

describe("Sessions Schema & Event Session ID", () => {
  test("creates the sessions table", () => {
    const db = initDatabase(":memory:");
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("sessions");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("sessions");
    db.close();
  });

  test("sessions table has correct columns", () => {
    const db = initDatabase(":memory:");
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((r) => r.name);
    
    expect(cols).toContain("id");
    expect(cols).toContain("developer_id");
    expect(cols).toContain("tool");
    expect(cols).toContain("started_at");
    expect(cols).toContain("ended_at");
    expect(cols).toContain("metadata");
    db.close();
  });

  test("event_queue table has session_id column", () => {
    const db = initDatabase(":memory:");
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(event_queue)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("session_id");
    db.close();
  });

  test("emitEvent persists session_id from payload", () => {
    const db = initDatabase(":memory:");
    const sessionId = "test-session-123";
    
    emitEvent(db, "session_start", {
      sessionId,
      agent: "test-agent",
    });

    const row = db
      .query<{ session_id: string }, []>("SELECT session_id FROM event_queue LIMIT 1")
      .get();
    
    expect(row).not.toBeNull();
    expect(row?.session_id).toBe(sessionId);
    db.close();
  });

  test("emitEvent handles missing sessionId in payload", () => {
    const db = initDatabase(":memory:");
    
    emitEvent(db, "error", {
      agent: "test-agent",
      message: "Something went wrong",
    });

    const row = db
      .query<{ session_id: string | null }, []>("SELECT session_id FROM event_queue LIMIT 1")
      .get();
    
    expect(row).not.toBeNull();
    expect(row?.session_id).toBeNull();
    db.close();
  });
});
