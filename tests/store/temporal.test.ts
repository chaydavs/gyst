/**
 * Unit tests for parseTimeReference and searchByTemporal from temporal.ts.
 *
 * Uses an in-memory database seeded with 7 entries at varying last_confirmed
 * timestamps to verify that:
 *  - parseTimeReference correctly identifies (or ignores) time signals
 *  - searchByTemporal filters, scores, and sorts results by recency
 *  - Archived and personal-scope entries are excluded
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import {
  parseTimeReference,
  searchByTemporal,
} from "../../src/store/temporal.js";

// ---------------------------------------------------------------------------
// Fixed reference time used for all tests — avoids flakiness from wall-clock
// ---------------------------------------------------------------------------

const NOW = new Date("2026-04-11T12:00:00.000Z");

// Helper: produce an ISO-8601 string N hours before NOW.
function hoursAgo(n: number): string {
  return new Date(NOW.getTime() - n * 3_600_000).toISOString();
}

// Helper: produce an ISO-8601 string N days before NOW.
function daysAgo(n: number): string {
  return hoursAgo(n * 24);
}

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");

  // Entry 1: confirmed right now (0h ago) — scope: team
  insertEntry(db, {
    id: "entry-now",
    type: "learning",
    title: "Entry confirmed right now",
    content: "Brand new entry confirmed just now.",
    files: [],
    tags: ["recent"],
    confidence: 0.9,
    sourceCount: 1,
    status: "active",
    scope: "team",
    lastConfirmed: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });

  // Entry 2: confirmed 6 hours ago — scope: team (within 12h "today" window)
  insertEntry(db, {
    id: "entry-6h",
    type: "convention",
    title: "Entry confirmed 6h ago",
    content: "This was confirmed 6 hours before the reference time.",
    files: [],
    tags: ["today"],
    confidence: 0.8,
    sourceCount: 1,
    status: "active",
    scope: "team",
    lastConfirmed: hoursAgo(6),
    createdAt: hoursAgo(6),
  });

  // Entry 3: confirmed 2 days ago — scope: project (within 7-day "recent" window)
  insertEntry(db, {
    id: "entry-2d",
    type: "decision",
    title: "Entry confirmed 2 days ago",
    content: "This was confirmed 2 days before the reference time.",
    files: [],
    tags: ["week"],
    confidence: 0.7,
    sourceCount: 1,
    status: "active",
    scope: "project",
    lastConfirmed: daysAgo(2),
    createdAt: daysAgo(2),
  });

  // Entry 4: confirmed 10 days ago — scope: team (outside 7-day window, inside 30-day)
  insertEntry(db, {
    id: "entry-10d",
    type: "error_pattern",
    title: "Entry confirmed 10 days ago",
    content: "This is older than a week but within a month.",
    files: [],
    tags: ["month"],
    confidence: 0.6,
    sourceCount: 1,
    status: "active",
    scope: "team",
    lastConfirmed: daysAgo(10),
    createdAt: daysAgo(10),
  });

  // Entry 5: confirmed 40 days ago — scope: team (outside 30-day window)
  insertEntry(db, {
    id: "entry-40d",
    type: "learning",
    title: "Entry confirmed 40 days ago",
    content: "Very old entry, outside all temporal windows.",
    files: [],
    tags: ["old"],
    confidence: 0.5,
    sourceCount: 1,
    status: "active",
    scope: "team",
    lastConfirmed: daysAgo(40),
    createdAt: daysAgo(40),
  });

  // Entry 6: archived — confirmed right now, must never appear
  insertEntry(db, {
    id: "entry-archived",
    type: "learning",
    title: "Archived entry confirmed right now",
    content: "This is archived and must be excluded from temporal results.",
    files: [],
    tags: ["archived"],
    confidence: 0.9,
    sourceCount: 1,
    status: "archived",
    scope: "team",
    lastConfirmed: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });

  // Entry 7: personal scope — confirmed right now, must never appear
  insertEntry(db, {
    id: "entry-personal",
    type: "learning",
    title: "Personal entry confirmed right now",
    content: "This has personal scope and must be excluded from temporal results.",
    files: [],
    tags: ["personal"],
    confidence: 0.8,
    sourceCount: 1,
    status: "active",
    scope: "personal",
    lastConfirmed: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  });
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// parseTimeReference
// ---------------------------------------------------------------------------

describe("parseTimeReference", () => {
  test("returns null for a query with no time reference", () => {
    const result = parseTimeReference("postgres error", NOW);
    expect(result).toBeNull();
  });

  test("returns null for an empty string", () => {
    const result = parseTimeReference("", NOW);
    expect(result).toBeNull();
  });

  test("yesterday → 48h–24h ago window", () => {
    const result = parseTimeReference("yesterday", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    const expectedBefore = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
    expect(result!.beforeIso).toBe(expectedBefore);
  });

  test("today → last 12 hours window", () => {
    const result = parseTimeReference("what happened today", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 12 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
    expect(result!.beforeIso).toBe(NOW.toISOString());
  });

  test("just now → last 12 hours window", () => {
    const result = parseTimeReference("errors from just now", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 12 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
  });

  test("recent errors → 7-day window", () => {
    const result = parseTimeReference("recent errors", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
    expect(result!.beforeIso).toBe(NOW.toISOString());
  });

  test("last week → 7-day window", () => {
    const result = parseTimeReference("decisions from last week", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
  });

  test("this week → 7-day window", () => {
    const result = parseTimeReference("this week's conventions", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
  });

  test("last month → 30-day window", () => {
    const result = parseTimeReference("errors from last month", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 30 * 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
  });

  test("case insensitive — YESTERDAY", () => {
    const result = parseTimeReference("YESTERDAY", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    const expectedBefore = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
    expect(result!.beforeIso).toBe(expectedBefore);
  });

  test("yesterday matches when embedded in a sentence", () => {
    const result = parseTimeReference("what failed yesterday in auth", NOW);
    expect(result).not.toBeNull();
    const expectedAfter = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
  });

  test("yesterday takes priority over last month (most specific match wins)", () => {
    const result = parseTimeReference("yesterday in the last month", NOW);
    expect(result).not.toBeNull();
    // Should produce the 48h–24h window, not the 30-day window
    const expectedAfter = new Date(NOW.getTime() - 48 * 3_600_000).toISOString();
    const expectedBefore = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    expect(result!.afterIso).toBe(expectedAfter);
    expect(result!.beforeIso).toBe(expectedBefore);
  });
});

// ---------------------------------------------------------------------------
// searchByTemporal
// ---------------------------------------------------------------------------

describe("searchByTemporal", () => {
  test("empty query returns empty array", () => {
    const results = searchByTemporal(db, "", NOW);
    expect(results).toEqual([]);
  });

  test("query with no time signal returns empty array", () => {
    const results = searchByTemporal(db, "postgres connection errors", NOW);
    expect(results).toEqual([]);
  });

  test("'today' query returns only entries within 12 hours", () => {
    // entry-now (0h ago) and entry-6h (6h ago) are within 12h
    // entry-2d (2 days) is not
    const results = searchByTemporal(db, "today", NOW);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-now");
    expect(ids).toContain("entry-6h");
    expect(ids).not.toContain("entry-2d");
    expect(ids).not.toContain("entry-10d");
    expect(ids).not.toContain("entry-40d");
  });

  test("'recent' query returns entries within 7 days but not beyond", () => {
    // entry-now, entry-6h, entry-2d are within 7 days; entry-10d (10 days) is not
    const results = searchByTemporal(db, "recent errors", NOW);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-now");
    expect(ids).toContain("entry-6h");
    expect(ids).toContain("entry-2d");
    expect(ids).not.toContain("entry-10d");
    expect(ids).not.toContain("entry-40d");
  });

  test("'last month' returns entries within 30 days but not 40 days ago", () => {
    // entry-now, entry-6h, entry-2d, entry-10d are within 30 days; entry-40d is not
    const results = searchByTemporal(db, "last month", NOW);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("entry-now");
    expect(ids).toContain("entry-6h");
    expect(ids).toContain("entry-2d");
    expect(ids).toContain("entry-10d");
    expect(ids).not.toContain("entry-40d");
  });

  test("archived entries are NOT returned", () => {
    // entry-archived is confirmed at NOW (within any window) but status='archived'
    const results = searchByTemporal(db, "last month", NOW);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("entry-archived");
  });

  test("personal-scope entries are NOT returned", () => {
    // entry-personal is confirmed at NOW but scope='personal'
    const results = searchByTemporal(db, "last month", NOW);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("entry-personal");
  });

  test("results are sorted by descending score (newest first)", () => {
    const results = searchByTemporal(db, "recent", NOW);
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("scores follow hyperbolic decay — today > yesterday > last week", () => {
    const results = searchByTemporal(db, "last month", NOW);
    const nowEntry = results.find((r) => r.id === "entry-now");
    const sixhEntry = results.find((r) => r.id === "entry-6h");
    const twodEntry = results.find((r) => r.id === "entry-2d");
    const tendEntry = results.find((r) => r.id === "entry-10d");

    expect(nowEntry).toBeDefined();
    expect(sixhEntry).toBeDefined();
    expect(twodEntry).toBeDefined();
    expect(tendEntry).toBeDefined();

    // Scores must decrease monotonically with age
    expect(nowEntry!.score).toBeGreaterThan(sixhEntry!.score);
    expect(sixhEntry!.score).toBeGreaterThan(twodEntry!.score);
    expect(twodEntry!.score).toBeGreaterThan(tendEntry!.score);
  });

  test("source field is 'temporal' for all results", () => {
    const results = searchByTemporal(db, "recent", NOW);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("temporal");
    }
  });

  test("all returned scores are positive", () => {
    const results = searchByTemporal(db, "recent", NOW);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});
