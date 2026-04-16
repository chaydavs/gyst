import { test, expect } from "bun:test";
import { parseAdr } from "../../../src/compiler/parsers/markdown-adr.js";

test("parses a real-style ADR with Date + Status preamble", () => {
  const md = [
    "# Decision: Add synonym query expansion to BM25 search",
    "",
    "Date: 2026-04-12",
    "Status: Accepted",
    "",
    "## Context",
    "",
    "The retrieval eval showed 12 of 50 queries were misses.",
    "",
    "## Decision",
    "",
    "We rewrote the expansion to emit FTS5 OR expressions.",
    "",
    "## Outcome",
    "",
    "Recall@5 rose from 0.69 to 0.82.",
  ].join("\n");

  const parsed = parseAdr("decisions/001-query-expansion.md", md);
  expect(parsed).not.toBeNull();
  expect(parsed!.number).toBe(1);
  expect(parsed!.title).toBe("Add synonym query expansion to BM25 search");
  expect(parsed!.status).toBe("Accepted");
  expect(parsed!.date).toBe("2026-04-12");
  expect(parsed!.sections.Context).toContain("retrieval eval");
  expect(parsed!.sections.Decision).toContain("FTS5 OR");
  expect(parsed!.summary).toContain("FTS5 OR"); // Decision is preferred over Context
});

test("parses ADR without `Decision:` title prefix", () => {
  const md = ["# Pick database engine", "", "Date: 2026-03-01", "", "## Context", "", "Needed ACID."].join("\n");
  const parsed = parseAdr("decisions/007-db-engine.md", md);
  expect(parsed!.title).toBe("Pick database engine");
  expect(parsed!.number).toBe(7);
});

test("returns null for markdown with no top-level heading", () => {
  expect(parseAdr("decisions/broken.md", "just some text")).toBeNull();
});

test("falls back to Context when Decision section is missing", () => {
  const md = [
    "# Decision: Switch to WebSockets",
    "",
    "## Context",
    "",
    "We need real-time events for the dashboard.",
  ].join("\n");
  const parsed = parseAdr("decisions/020-websockets.md", md);
  expect(parsed!.summary).toContain("real-time");
});

test("handles multi-digit ADR numbers (4-digit) correctly", () => {
  const md = "# Decision: Future thing\n\nContent";
  const parsed = parseAdr("decisions/1024-future.md", md);
  expect(parsed!.number).toBe(1024);
});
