import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { findDuplicate, mergeEntries } from "../../src/compiler/deduplicate.js";
import type { KnowledgeEntry } from "../../src/compiler/extract.js";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(() => {
  db = initDatabase(":memory:");
});

afterAll(() => {
  db.close();
});

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: "learning",
    title: "Default test entry title here",
    content: "Default test entry content for testing purposes here.",
    files: [],
    tags: [],
    confidence: 0.5,
    sourceCount: 1,
    status: "active",
    createdAt: now,
    lastConfirmed: now,
    ...overrides,
  };
}

function persistEntry(entry: KnowledgeEntry): void {
  insertEntry(db, {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    files: entry.files,
    tags: entry.tags,
    errorSignature: entry.fingerprint, // stored in error_signature column
    confidence: entry.confidence,
    sourceCount: entry.sourceCount,
    sourceTool: entry.sourceTool,
    createdAt: entry.createdAt,
    lastConfirmed: entry.lastConfirmed,
    status: entry.status,
  });
}

// ---------------------------------------------------------------------------
// findDuplicate
// ---------------------------------------------------------------------------

describe("findDuplicate", () => {
  test("returns null for a new entry with no matching fingerprint or overlap", () => {
    const entry = makeEntry({ id: crypto.randomUUID(), tags: ["unique-tag-xyz"] });
    const result = findDuplicate(db, entry);
    expect(result).toBeNull();
  });

  test("returns null when entry has no tags, files, or fingerprint", () => {
    const entry = makeEntry({ tags: [], files: [] });
    const result = findDuplicate(db, entry);
    expect(result).toBeNull();
  });

  test("finds duplicate by fingerprint match", () => {
    const fingerprint = "abc123def456abc1"; // 16 hex chars

    // Persist an existing entry whose error_signature matches the fingerprint
    const existing = makeEntry({
      type: "error_pattern",
      fingerprint,
      // insertEntry stores fingerprint in errorSignature field
    });
    // Store via insertEntry with errorSignature set to the fingerprint value
    insertEntry(db, {
      id: existing.id,
      type: existing.type,
      title: existing.title,
      content: existing.content,
      files: existing.files,
      tags: existing.tags,
      errorSignature: fingerprint,
      confidence: existing.confidence,
      sourceCount: existing.sourceCount,
      createdAt: existing.createdAt,
      lastConfirmed: existing.lastConfirmed,
      status: existing.status,
    });

    // New entry has same fingerprint
    const incoming = makeEntry({
      type: "error_pattern",
      fingerprint,
    });
    const result = findDuplicate(db, incoming);
    expect(result).toBe(existing.id);
  });

  test("does not match an archived entry by fingerprint", () => {
    const fingerprint = "deadbeefdeadbeef";

    const existing = makeEntry({ type: "error_pattern" });
    insertEntry(db, {
      id: existing.id,
      type: existing.type,
      title: existing.title,
      content: existing.content,
      files: existing.files,
      tags: existing.tags,
      errorSignature: fingerprint,
      confidence: existing.confidence,
      sourceCount: existing.sourceCount,
      createdAt: existing.createdAt,
      lastConfirmed: existing.lastConfirmed,
      status: "archived",
    });

    const incoming = makeEntry({ type: "error_pattern", fingerprint });
    const result = findDuplicate(db, incoming);
    expect(result).toBeNull();
  });

  test("finds duplicate by Jaccard similarity when tags overlap >= 0.6", () => {
    // Existing entry with tags [a, b, c]
    const existing = makeEntry({
      type: "convention",
      tags: ["typescript", "style", "formatting"],
      files: [],
    });
    persistEntry(existing);

    // Incoming entry with tags [a, b, c] — full overlap → Jaccard = 1.0
    const incoming = makeEntry({
      type: "convention",
      tags: ["typescript", "style", "formatting"],
      files: [],
    });
    const result = findDuplicate(db, incoming);
    expect(result).toBe(existing.id);
  });

  test("does not match by Jaccard when overlap is below threshold", () => {
    // Existing: [a, b, c, d, e] (5 items)
    const existing = makeEntry({
      type: "convention",
      tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
      files: [],
    });
    persistEntry(existing);

    // Incoming: [a, x, y, z] — intersection={a}, union={a,b,c,d,e,x,y,z}=8 → 1/8 = 0.125 < 0.6
    const incoming = makeEntry({
      type: "convention",
      tags: ["alpha", "xi", "psi", "omega"],
      files: [],
    });
    const result = findDuplicate(db, incoming);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeEntries
// ---------------------------------------------------------------------------

describe("mergeEntries", () => {
  test("returns a new object (does not mutate existing or incoming)", () => {
    const existing = makeEntry({ sourceCount: 1, tags: ["a"], files: [] });
    const incoming = makeEntry({ sourceCount: 1, tags: ["b"], files: [] });
    const merged = mergeEntries(existing, incoming);
    expect(merged).not.toBe(existing);
    expect(merged).not.toBe(incoming);
    expect(existing.tags).toEqual(["a"]); // unchanged
    expect(incoming.tags).toEqual(["b"]); // unchanged
  });

  test("combines source counts", () => {
    const existing = makeEntry({ sourceCount: 3 });
    const incoming = makeEntry({ sourceCount: 2 });
    const merged = mergeEntries(existing, incoming);
    expect(merged.sourceCount).toBe(5);
  });

  test("unions files without duplicates", () => {
    const existing = makeEntry({ files: ["src/a.ts", "src/b.ts"] });
    const incoming = makeEntry({ files: ["src/b.ts", "src/c.ts"] });
    const merged = mergeEntries(existing, incoming);
    expect(merged.files.sort()).toEqual(
      ["src/a.ts", "src/b.ts", "src/c.ts"].sort(),
    );
  });

  test("unions tags without duplicates", () => {
    const existing = makeEntry({ tags: ["typescript", "style"] });
    const incoming = makeEntry({ tags: ["style", "testing"] });
    const merged = mergeEntries(existing, incoming);
    expect(merged.tags.sort()).toEqual(
      ["style", "testing", "typescript"].sort(),
    );
  });

  test("takes content from whichever entry has newer lastConfirmed", () => {
    const older = makeEntry({
      content: "Old content that should be replaced by newer.",
      lastConfirmed: "2024-01-01T00:00:00.000Z",
    });
    const newer = makeEntry({
      content: "New content that is more recent and should win.",
      lastConfirmed: "2024-06-01T00:00:00.000Z",
    });
    const merged = mergeEntries(older, newer);
    expect(merged.content).toBe("New content that is more recent and should win.");
  });

  test("keeps existing content when existing is newer", () => {
    const existing = makeEntry({
      content: "Existing content that is the most up to date.",
      lastConfirmed: "2024-12-01T00:00:00.000Z",
    });
    const incoming = makeEntry({
      content: "Incoming older content that should not override existing.",
      lastConfirmed: "2024-01-01T00:00:00.000Z",
    });
    const merged = mergeEntries(existing, incoming);
    expect(merged.content).toBe(
      "Existing content that is the most up to date.",
    );
  });

  test("takes maximum confidence", () => {
    const existing = makeEntry({ confidence: 0.4 });
    const incoming = makeEntry({ confidence: 0.8 });
    const merged = mergeEntries(existing, incoming);
    expect(merged.confidence).toBe(0.8);
  });

  test("preserves existing entry id", () => {
    const existing = makeEntry();
    const incoming = makeEntry();
    const merged = mergeEntries(existing, incoming);
    expect(merged.id).toBe(existing.id);
  });

  test("updates lastConfirmed to the more recent value", () => {
    const existing = makeEntry({
      lastConfirmed: "2024-01-01T00:00:00.000Z",
    });
    const incoming = makeEntry({
      lastConfirmed: "2024-06-01T00:00:00.000Z",
    });
    const merged = mergeEntries(existing, incoming);
    expect(merged.lastConfirmed).toBe("2024-06-01T00:00:00.000Z");
  });

  test("handles empty files and tags gracefully", () => {
    const existing = makeEntry({ files: [], tags: [] });
    const incoming = makeEntry({ files: [], tags: [] });
    const merged = mergeEntries(existing, incoming);
    expect(merged.files).toEqual([]);
    expect(merged.tags).toEqual([]);
  });

  test("preserves existing type and title", () => {
    const existing = makeEntry({ type: "convention", title: "Use strict mode always" });
    const incoming = makeEntry({ type: "learning", title: "Different title here" });
    const merged = mergeEntries(existing, incoming);
    expect(merged.type).toBe("convention");
    expect(merged.title).toBe("Use strict mode always");
  });
});
