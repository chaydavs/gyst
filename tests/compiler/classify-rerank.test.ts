import { test, expect, beforeEach } from "bun:test";
import { initDatabase } from "../../src/store/database.js";
import { insertEntry } from "../../src/store/database.js";
import { classifyEvent } from "../../src/compiler/classify-event.js";
import {
  rerankWithGraphify,
  RERANK_RULE_IDS,
} from "../../src/compiler/classify-rerank.js";

function fresh() {
  return initDatabase(":memory:");
}

function seed(
  db: ReturnType<typeof fresh>,
  count: number,
  type: "convention" | "error_pattern",
  entityName: string,
): void {
  for (let i = 0; i < count; i++) {
    insertEntry(db, {
      id: `seed-${type}-${i}`,
      type,
      title: `${type} about ${entityName} #${i}`,
      content: `body about ${entityName}`,
      files: [],
      tags: [`entity:${entityName}`],
      confidence: 0.7,
      sourceCount: 1,
    });
  }
}

let db: ReturnType<typeof fresh>;
beforeEach(() => {
  db = fresh();
});

test("novel entity leaves signalStrength intact and tags graph-novel", () => {
  const stage1 = classifyEvent({
    type: "prompt",
    payload: { text: "we always use camelCase for getUserName identifiers" },
  });
  const after = rerankWithGraphify(db, stage1, {
    text: "we always use camelCase for getUserName identifiers",
  });
  expect(after.signalStrength).toBe(stage1.signalStrength);
  expect(after.ruleIds).toContain(RERANK_RULE_IDS.GRAPH_NOVEL);
});

test("≥2 existing same-entity conventions demote signalStrength", () => {
  seed(db, 2, "convention", "getUserName");
  const stage1 = classifyEvent({
    type: "prompt",
    payload: { text: "we always use camelCase for getUserName identifiers" },
  });
  const after = rerankWithGraphify(db, stage1, {
    text: "we always use camelCase for getUserName identifiers",
  });
  expect(after.signalStrength).toBeLessThan(stage1.signalStrength);
  expect(after.ruleIds).toContain(RERANK_RULE_IDS.GRAPH_DUP_CLUSTER);
});

test("≥5 existing same-entity conventions suppress aggressively", () => {
  seed(db, 5, "convention", "handleRequest");
  const stage1 = classifyEvent({
    type: "prompt",
    payload: { text: "we always use camelCase for handleRequest identifiers" },
  });
  const after = rerankWithGraphify(db, stage1, {
    text: "we always use camelCase for handleRequest identifiers",
  });
  expect(after.signalStrength).toBeLessThanOrEqual(stage1.signalStrength - 0.5);
  expect(after.ruleIds).toContain(RERANK_RULE_IDS.GRAPH_SUPPRESS);
});

test("non-rerank types (learning) bypass the rerank", () => {
  seed(db, 5, "convention", "foo");
  const stage1 = classifyEvent({
    type: "prompt",
    payload: { text: "this is some long learning about foo bar baz xyzzy quux" },
  });
  const after = rerankWithGraphify(db, stage1, {
    text: "this is some long learning about foo bar baz xyzzy quux",
  });
  // learning is not in TYPES_TO_RERANK
  expect(after.signalStrength).toBe(stage1.signalStrength);
});

test("empty payload text short-circuits to original verdict", () => {
  seed(db, 10, "convention", "anything");
  const stage1 = classifyEvent({
    type: "tool_use",
    payload: { tool: "Bash", error: "Error: ENOENT" },
  });
  const after = rerankWithGraphify(db, stage1, {});
  expect(after).toEqual(stage1);
});
