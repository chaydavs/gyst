#!/usr/bin/env bun
/**
 * LLM-assisted pre-labelling for the classifier eval fixture corpus.
 *
 * Pipes unlabelled JSONL rows (from `export-classifier-labels.ts`) through
 * Claude Haiku, predicts the `expected.*` fields, and writes schema-valid
 * rows the human can review — turning 150 rows of manual labelling into a
 * 10-minute spot-check pass.
 *
 * Contract:
 *   - Reads line-delimited JSON; each line must parse but need not match
 *     LabelRowSchema yet (the placeholder rows from the exporter don't).
 *   - Skips rows whose `expected.candidateType` is already non-null — this
 *     keeps reruns idempotent and lets you hand-correct a row then re-run.
 *   - Fail-soft per row: on error, keeps the placeholder and records the
 *     reason in `notes` so a human review can find and fix it.
 *   - Every output row passes `LabelRowSchema.strict()`.
 *
 * Usage:
 *   bun run scripts/auto-label-classifier.ts \
 *     --in /tmp/labels-to-fill.jsonl \
 *     --out /tmp/labels-auto.jsonl \
 *     [--budget 200]
 *
 * Requires ANTHROPIC_API_KEY. Without it the script exits 2 before any I/O.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  CANDIDATE_TYPES,
  SCOPE_HINTS,
  LabelRowSchema,
  type LabelRow,
} from "../src/compiler/classifier-eval-schema.js";

const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 400;
const TIMEOUT_MS = 15_000;
const DEFAULT_BUDGET = 200;

// Haiku emits the literal string "null" more reliably than JSON `null`;
// we accept either and normalise downstream.
export const AutoLabelResponseSchema = z.object({
  candidateType: z.enum([...CANDIDATE_TYPES, "null"] as const),
  scopeHint: z.enum(SCOPE_HINTS),
  subcategory: z.string().min(1).max(40).optional(),
  reasoning: z.string().min(1).max(300),
});
export type AutoLabelResponse = z.infer<typeof AutoLabelResponseSchema>;

export interface AutoLabelOptions {
  readonly fetchFn?: typeof fetch;
  readonly apiKey?: string;
}

/** Build the user-message prompt. Exported for testing. */
export function buildPrompt(row: UnlabelledRow): string {
  const payloadText = truncate(JSON.stringify(row.payload), 800);
  return [
    "You are labelling developer events for a classifier training fixture.",
    "Pick exactly ONE curated type this event should become, or 'null' to reject.",
    "",
    `event_type: ${row.event_type}`,
    `payload: ${payloadText}`,
    "",
    "Types:",
    "- convention: a rule for how THIS team writes code (naming, format, patterns)",
    "- error_pattern: a known failure mode (tsc error, runtime error, etc.)",
    "- decision: an architectural choice WITH rationale",
    "- learning: a concrete insight grounded in a specific symbol/API",
    '- null: filler, questions, historical facts, soft qualifiers ("usually", "sometimes"), or prompts that assert nothing',
    "",
    "scopeHint: 'team' (applies to the repo), 'personal' (one developer), 'uncertain' (unclear or N/A).",
    "",
    'Respond with ONLY compact JSON: {"candidateType":"convention"|"error_pattern"|"decision"|"learning"|"null","scopeHint":"team"|"personal"|"uncertain","subcategory":"short-tag","reasoning":"one sentence"}',
    "Omit subcategory when candidateType is null.",
  ].join("\n");
}

interface UnlabelledRow {
  readonly id: string;
  readonly event_type: LabelRow["event_type"];
  readonly payload: Record<string, unknown>;
  readonly expected: {
    readonly candidateType: LabelRow["expected"]["candidateType"];
    readonly scopeHint: LabelRow["expected"]["scopeHint"];
    readonly subcategory?: string;
  };
  readonly split: LabelRow["split"];
  readonly source: LabelRow["source"];
  readonly notes?: string;
}

/**
 * Normalises the JSON Haiku returned into the `expected` shape the fixture
 * schema wants. Exported so tests can exercise it with canned responses.
 */
export function applyAutoLabel(
  row: UnlabelledRow,
  response: AutoLabelResponse,
): LabelRow {
  const resolvedType =
    response.candidateType === "null"
      ? null
      : response.candidateType;
  const baseExpected: LabelRow["expected"] = {
    candidateType: resolvedType,
    scopeHint: response.scopeHint,
    ...(resolvedType !== null && response.subcategory
      ? { subcategory: response.subcategory }
      : {}),
  };
  return {
    id: row.id,
    event_type: row.event_type,
    payload: row.payload,
    expected: baseExpected,
    split: row.split,
    source: row.source,
    notes: `auto-labelled — review: ${response.reasoning}`,
  };
}

interface AnthropicMessagesResponse {
  readonly content?: ReadonlyArray<{ type: string; text?: string }>;
}

async function callAnthropic(
  prompt: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as AnthropicMessagesResponse;
    const first = json.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      throw new Error("anthropic: missing text content");
    }
    return first.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Labels a single row. Fail-soft: on any error (network, schema mismatch,
 * API refusal) returns a placeholder row tagged with the failure reason.
 */
export async function labelRow(
  row: UnlabelledRow,
  options: AutoLabelOptions = {},
): Promise<LabelRow> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — gate in main() should have caught this");
  }
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const raw = await callAnthropic(buildPrompt(row), apiKey, fetchFn);
    const parsed = AutoLabelResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return placeholderWithNote(row, `auto-label: schema mismatch (${parsed.error.message.slice(0, 80)})`);
    }
    return applyAutoLabel(row, parsed.data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return placeholderWithNote(row, `auto-label failed: ${msg.slice(0, 120)}`);
  }
}

function placeholderWithNote(row: UnlabelledRow, note: string): LabelRow {
  return {
    id: row.id,
    event_type: row.event_type,
    payload: row.payload,
    expected: {
      candidateType: null,
      scopeHint: "uncertain",
    },
    split: row.split,
    source: row.source,
    notes: note,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

interface CliArgs {
  readonly in: string;
  readonly out: string;
  readonly budget: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        map.set(key, value);
        i += 1;
      }
    }
  }
  const inPath = map.get("in");
  const outPath = map.get("out");
  if (!inPath || !outPath) {
    throw new Error("--in <path> and --out <path> are required");
  }
  return {
    in: inPath,
    out: outPath,
    budget: Number(map.get("budget") ?? DEFAULT_BUDGET),
  };
}

/**
 * True when a row already carries a human or prior-run label. These are
 * passed through untouched so reruns don't overwrite corrections.
 */
function isAlreadyLabelled(row: UnlabelledRow): boolean {
  return row.expected.candidateType !== null;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY not set — refusing to run.\n");
    process.exit(2);
  }

  const input = readFileSync(args.in, "utf8");
  const lines = input.split("\n").filter((l) => l.trim().length > 0);

  const out: LabelRow[] = [];
  let labelled = 0;
  let skipped = 0;
  let budgetLeft = args.budget;

  for (const line of lines) {
    const row = JSON.parse(line) as UnlabelledRow;
    if (isAlreadyLabelled(row)) {
      const parsed = LabelRowSchema.safeParse(row);
      if (parsed.success) {
        out.push(parsed.data);
        skipped += 1;
        continue;
      }
    }
    if (budgetLeft <= 0) {
      out.push(placeholderWithNote(row, "auto-label skipped: budget exhausted"));
      continue;
    }
    const labelled_row = await labelRow(row);
    out.push(labelled_row);
    labelled += 1;
    budgetLeft -= 1;
  }

  const lines_out = out.map((r) => JSON.stringify(r));
  writeFileSync(args.out, lines_out.join("\n") + (lines_out.length > 0 ? "\n" : ""));

  process.stdout.write(
    `Auto-labelled ${labelled} rows, skipped ${skipped} pre-labelled, ${lines.length} total → ${args.out}\n`,
  );
  process.stdout.write(
    `Next: open ${args.out} in a review tool, spot-check auto-labelled rows, append accepted ones to tests/fixtures/classifier-eval/labels.jsonl\n`,
  );
}

if (import.meta.main) {
  main();
}
