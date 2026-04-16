import { test, expect } from "bun:test";
import { parsePlanDoc } from "../../../src/compiler/parsers/markdown-headings.js";

test("parses a typical plan doc with Goal label + sections + checkboxes", () => {
  const md = [
    "# Universal Capture Pipeline — Phase 1 Plan",
    "",
    "**Goal:** Close hook-coverage holes across every AI agent.",
    "**Architecture:** Two-channel capture — hooks plus MCP dispatcher.",
    "",
    "---",
    "",
    "## File Structure",
    "",
    "**Modify:**",
    "- src/cli/install.ts — extend mergeClaudeHooks.",
    "",
    "## Tasks",
    "",
    "- [x] classify-event.ts written",
    "- [x] process-events.ts written",
    "- [ ] install.ts scriptsDir fix",
    "- [ ] dashboard recap view",
  ].join("\n");

  const parsed = parsePlanDoc(md);
  expect(parsed).not.toBeNull();
  expect(parsed!.title).toBe("Universal Capture Pipeline — Phase 1 Plan");
  expect(parsed!.labels.Goal).toContain("hook-coverage");
  expect(parsed!.labels.Architecture).toContain("Two-channel");
  expect(parsed!.sections.length).toBe(2);
  expect(parsed!.sections[0].heading).toBe("File Structure");
  expect(parsed!.tasks.total).toBe(4);
  expect(parsed!.tasks.done).toBe(2);
  expect(parsed!.tasks.open).toBe(2);
  expect(parsed!.summary).toContain("Goal:");
  expect(parsed!.summary).toContain("2/4 tasks done");
});

test("returns null for plan with no top-level heading", () => {
  expect(parsePlanDoc("no title here\n\njust paragraphs")).toBeNull();
});

test("handles plan with zero tasks gracefully", () => {
  const md = [
    "# Read-only design note",
    "",
    "**Goal:** Explore options",
    "",
    "## Context",
    "",
    "Some discussion goes here.",
  ].join("\n");
  const parsed = parsePlanDoc(md);
  expect(parsed!.tasks.total).toBe(0);
  expect(parsed!.tasks.done).toBe(0);
  expect(parsed!.sections.length).toBe(1);
});

test("captures ### subsections alongside ## sections", () => {
  const md = [
    "# Layered plan",
    "",
    "## Phase 1",
    "",
    "Work to do here.",
    "",
    "### Step 1.a",
    "",
    "Detail line.",
  ].join("\n");
  const parsed = parsePlanDoc(md);
  expect(parsed!.sections.length).toBe(2);
  expect(parsed!.sections[1].level).toBe(3);
  expect(parsed!.sections[1].heading).toBe("Step 1.a");
});
