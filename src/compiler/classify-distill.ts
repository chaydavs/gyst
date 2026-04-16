/**
 * Stage 3 of the classification pipeline — LLM distillation.
 *
 * When enabled, asks Claude Haiku 4.5 to adjudicate borderline verdicts.
 * "Borderline" means Stage 2's `signalStrength` landed in a narrow band
 * around the promotion threshold — precisely the cases where rule-level
 * signal is ambiguous and human-like judgement helps.
 *
 * Gates (ALL must hold, else the input verdict is returned unchanged):
 *   1. `process.env.ANTHROPIC_API_KEY` is set.
 *   2. `signalStrength` is in [BORDERLINE_MIN, BORDERLINE_MAX].
 *   3. Per-batch budget has not been exhausted.
 *
 * The distiller is fail-soft at every layer. Network error, bad JSON,
 * unknown type — each returns the input verdict and logs a warning.
 * Classification must never break because the LLM hiccuped.
 *
 * Zero new runtime dependencies: uses global `fetch` directly. Tests
 * inject a mock via the `fetchFn` parameter.
 */

import { z } from "zod";
import { logger } from "../utils/logger.js";
import type { Classification, EntryType } from "./classify-event.js";

/** Band around the 0.5 threshold where rules are least confident. */
const BORDERLINE_MIN = 0.4;
const BORDERLINE_MAX = 0.6;

/** Per-batch ceiling on distill calls. Matches the plan's cost envelope. */
const DEFAULT_BUDGET = 50;

const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 300;
const TIMEOUT_MS = 10_000;

export const DISTILL_RULE_IDS = {
  DISTILL_AMPLIFIED: "distill-amplified",
  DISTILL_SUPPRESSED: "distill-suppressed",
  DISTILL_AGREED: "distill-agreed",
} as const;

export interface DistillOptions {
  /** Override global fetch for testing. */
  readonly fetchFn?: typeof fetch;
  /** Override the per-batch budget. Defaults to 50. */
  readonly budget?: number;
}

/** In-memory batch counter. Reset at the start of each processEvents run. */
let callsRemaining = DEFAULT_BUDGET;
let budgetExhaustedLogged = false;

/** Call this at the start of each processing batch to refill the budget. */
export function resetDistillBudget(budget: number = DEFAULT_BUDGET): void {
  callsRemaining = budget;
  budgetExhaustedLogged = false;
}

function isBorderline(signal: number): boolean {
  return signal >= BORDERLINE_MIN && signal <= BORDERLINE_MAX;
}

/** Schema Claude is asked to produce. `reasoning` is free text. */
const DistillResponseSchema = z.object({
  type: z.enum(["convention", "error_pattern", "decision", "learning", "none"]),
  reasoning: z.string().min(1).max(500),
});

function buildPrompt(
  verdict: Classification,
  payload: Record<string, unknown>,
): string {
  const text =
    typeof payload.text === "string" ? payload.text
    : typeof payload.message === "string" ? payload.message
    : JSON.stringify(payload).slice(0, 500);
  return [
    "You are classifying events for an engineering-team knowledge base.",
    "Given one event, decide which single curated type it belongs to.",
    "",
    `Rule-based verdict: type=${verdict.candidateType ?? "none"}, signal=${verdict.signalStrength.toFixed(2)}, rules=${verdict.ruleIds.join(",") || "none"}`,
    "",
    "Event payload:",
    text,
    "",
    'Respond with ONLY compact JSON matching {"type":"convention"|"error_pattern"|"decision"|"learning"|"none","reasoning":"one sentence"}.',
    'Use "none" when the event should not become a curated entry.',
  ].join("\n");
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

function applyDistillResult(
  verdict: Classification,
  resolvedType: EntryType | null,
  reasoning: string,
): Classification {
  const before = verdict.candidateType;
  if (resolvedType === null) {
    return {
      ...verdict,
      candidateType: null,
      signalStrength: Math.min(verdict.signalStrength, BORDERLINE_MIN - 0.01),
      ruleIds: [...verdict.ruleIds, DISTILL_RULE_IDS.DISTILL_SUPPRESSED],
      reasoning,
    };
  }
  if (resolvedType === before) {
    // Distillation agreed — lift signal just above the threshold so the
    // entry is created, but don't inflate it artificially.
    return {
      ...verdict,
      signalStrength: Math.max(verdict.signalStrength, 0.55),
      ruleIds: [...verdict.ruleIds, DISTILL_RULE_IDS.DISTILL_AGREED],
      reasoning,
    };
  }
  return {
    ...verdict,
    candidateType: resolvedType,
    signalStrength: Math.max(verdict.signalStrength, 0.6),
    ruleIds: [...verdict.ruleIds, DISTILL_RULE_IDS.DISTILL_AMPLIFIED],
    reasoning,
  };
}

/**
 * Adjudicates borderline verdicts with a Claude Haiku call when gated on
 * the API key. Returns the input verdict unchanged when any gate fails or
 * any step errors — this is the hot path; we prefer a missed amplification
 * to a crashed batch.
 */
export async function distillWithLLM(
  verdict: Classification,
  payload: Record<string, unknown>,
  options: DistillOptions = {},
): Promise<Classification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.length === 0) return verdict;
  if (!isBorderline(verdict.signalStrength)) return verdict;
  if (callsRemaining <= 0) {
    if (!budgetExhaustedLogged) {
      logger.warn("classify-distill: budget exhausted for this batch");
      budgetExhaustedLogged = true;
    }
    return verdict;
  }
  callsRemaining -= 1;

  const fetchFn = options.fetchFn ?? fetch;
  try {
    const raw = await callAnthropic(buildPrompt(verdict, payload), apiKey, fetchFn);
    const parsed = DistillResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn("classify-distill: response failed schema", {
        error: parsed.error.message,
        raw: raw.slice(0, 200),
      });
      return verdict;
    }
    const resolvedType =
      parsed.data.type === "none" ? null : (parsed.data.type as EntryType);
    return applyDistillResult(verdict, resolvedType, parsed.data.reasoning);
  } catch (err) {
    logger.warn("classify-distill: call failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return verdict;
  }
}
