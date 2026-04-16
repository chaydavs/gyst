/**
 * Fixture smoke test — validates every row in labels.jsonl against the Zod
 * schema. A green run means the corpus is consumable by the eval harness.
 * A red run means a labeller left a malformed row.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LabelRowSchema,
  type LabelRow,
} from "../../../src/compiler/classifier-eval-schema.js";

const FIXTURE_PATH = join(import.meta.dir, "labels.jsonl");

function readRows(): LabelRow[] {
  const contents = readFileSync(FIXTURE_PATH, "utf8");
  const lines = contents.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`labels.jsonl line ${idx + 1}: invalid JSON (${msg})`);
    }
    const result = LabelRowSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `labels.jsonl line ${idx + 1} (id=${(parsed as { id?: string }).id}): ${result.error.message}`,
      );
    }
    return result.data;
  });
}

test("every row parses against the schema", () => {
  const rows = readRows();
  expect(rows.length).toBeGreaterThan(0);
});

test("ids are unique", () => {
  const rows = readRows();
  const ids = new Set<string>();
  for (const row of rows) {
    expect(ids.has(row.id)).toBe(false);
    ids.add(row.id);
  }
});

test("adversarial rows are all in the test split", () => {
  const rows = readRows();
  for (const row of rows) {
    if (row.source === "adversarial") {
      expect(row.split).toBe("test");
    }
  }
});

test("signal-strength bounds are coherent when both present", () => {
  const rows = readRows();
  for (const row of rows) {
    const { signalStrengthMin, signalStrengthMax } = row.expected;
    if (signalStrengthMin !== undefined && signalStrengthMax !== undefined) {
      expect(signalStrengthMin).toBeLessThanOrEqual(signalStrengthMax);
    }
  }
});
