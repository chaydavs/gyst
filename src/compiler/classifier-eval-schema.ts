/**
 * Zod schema for the classifier eval fixture corpus.
 *
 * Source of truth for row shape. The eval harness and the fixture smoke test
 * both consume this module — never hand-roll parsing against labels.jsonl.
 *
 * The schema is intentionally strict: unknown keys are rejected so a typo in
 * a hand-labelled row fails loudly in the smoke test rather than silently
 * dropping through to the eval runner.
 */

import { z } from "zod";

export const EVENT_TYPES = [
  "prompt",
  "tool_use",
  "plan_added",
  "commit",
  "md_change",
] as const;

/** Candidate entry types. `null` encodes "should be rejected — no entry". */
export const CANDIDATE_TYPES = [
  "convention",
  "error_pattern",
  "decision",
  "learning",
] as const;

export const SCOPE_HINTS = ["personal", "team", "uncertain"] as const;

const ExpectedSchema = z
  .object({
    candidateType: z.enum(CANDIDATE_TYPES).nullable(),
    scopeHint: z.enum(SCOPE_HINTS),
    subcategory: z.string().min(1).optional(),
    signalStrengthMin: z.number().min(0).max(1).optional(),
    signalStrengthMax: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (e) =>
      e.signalStrengthMin === undefined ||
      e.signalStrengthMax === undefined ||
      e.signalStrengthMin <= e.signalStrengthMax,
    { message: "signalStrengthMin must be <= signalStrengthMax" },
  );

export const LabelRowSchema = z
  .object({
    id: z.string().min(1),
    event_type: z.enum(EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
    expected: ExpectedSchema,
    split: z.enum(["train", "test"]),
    source: z.enum(["adversarial", "real"]),
    notes: z.string().optional(),
  })
  .strict();

export type LabelRow = z.infer<typeof LabelRowSchema>;
