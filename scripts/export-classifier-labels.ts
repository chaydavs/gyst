#!/usr/bin/env bun
/**
 * Export recent `event_queue` rows into a ready-to-label JSONL file.
 *
 * Workflow (plan Task 0):
 *   1. Run this script against your local .gyst/wiki.db
 *   2. Paste the output into a Google Sheet with expected.* columns blank
 *   3. Hand-label in one sitting
 *   4. Paste labelled rows back under tests/fixtures/classifier-eval/labels.jsonl
 *
 * Every payload is passed through `stripSensitiveData` before writing, so
 * nothing sensitive lands in the fixture file even if it leaked into events.
 *
 * Usage:
 *   bun run scripts/export-classifier-labels.ts \
 *     --db .gyst/wiki.db \
 *     --since 30d \
 *     --types prompt,tool_use,plan_added \
 *     --out /tmp/labels-to-fill.jsonl
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripSensitiveData } from "../src/compiler/security.js";

interface CliArgs {
  readonly db: string;
  readonly since: string;
  readonly types: readonly string[];
  readonly out: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args.set(key, value);
        i += 1;
      }
    }
  }
  return {
    db: args.get("db") ?? ".gyst/wiki.db",
    since: args.get("since") ?? "30d",
    types: (args.get("types") ?? "prompt,tool_use,plan_added").split(","),
    out: args.get("out") ?? "/tmp/labels-to-fill.jsonl",
  };
}

function sinceToIsoCutoff(since: string): string {
  const match = since.match(/^(\d+)([dhm])$/);
  if (!match) throw new Error(`--since must match /\\d+[dhm]/, got ${since}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "d" ? amount * 24 * 60 * 60 * 1000
    : unit === "h" ? amount * 60 * 60 * 1000
    : amount * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

/** Assign 80/20 train/test split deterministically by id. */
function splitForId(id: string): "train" | "test" {
  const hash = createHash("sha256").update(id).digest();
  const bucket = hash[0]! % 10;
  return bucket < 8 ? "train" : "test";
}

/**
 * Anonymise a JSON payload by parsing it and running `stripSensitiveData` on
 * each leaf string. Walking the tree (rather than stripping the raw JSON
 * blob) keeps the structure intact — a naive blob-strip would replace
 * `"cwd":"/path"` with `"cwd":[REDACTED]` and break parsing downstream.
 */
function anonymisePayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { _raw: stripSensitiveData(raw) };
  }
  return stripLeaves(parsed) as Record<string, unknown>;
}

function stripLeaves(value: unknown): unknown {
  if (typeof value === "string") return stripSensitiveData(value);
  if (Array.isArray(value)) return value.map(stripLeaves);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripLeaves(v);
    }
    return out;
  }
  return value;
}

function main(): void {
  const { db: dbPath, since, types, out } = parseArgs(Bun.argv.slice(2));
  const cutoff = sinceToIsoCutoff(since);

  // WAL-mode DBs need RW on the sidecar files even for SELECT. Open read-write
  // but never issue a mutation; `create: false` keeps us from accidentally
  // creating a blank DB if the path is wrong.
  const db = new Database(dbPath, { readwrite: true, create: false });
  const placeholders = types.map(() => "?").join(",");
  const rows = db
    .query<
      { id: number; type: string; payload: string; created_at: string },
      (string | number)[]
    >(
      `SELECT id, type, payload, created_at
         FROM event_queue
        WHERE type IN (${placeholders})
          AND created_at >= ?
        ORDER BY id DESC`,
    )
    .all(...types, cutoff);

  const out_lines: string[] = [];
  for (const row of rows) {
    const id = `real-${row.id.toString().padStart(5, "0")}`;
    const payload = anonymisePayload(row.payload);
    const labelRow = {
      id,
      event_type: row.type,
      payload,
      expected: {
        candidateType: null,
        scopeHint: "uncertain",
      },
      split: splitForId(id),
      source: "real",
      notes: "TODO: label — fill expected.candidateType, scopeHint, subcategory",
    };
    out_lines.push(JSON.stringify(labelRow));
  }

  writeFileSync(out, out_lines.join("\n") + (out_lines.length > 0 ? "\n" : ""));
  console.log(`Wrote ${out_lines.length} rows to ${out}`);
  console.log(`Next: open ${out}, fill expected.* fields, append to tests/fixtures/classifier-eval/labels.jsonl`);
}

main();
