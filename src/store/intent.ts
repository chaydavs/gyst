/**
 * Intent classifier and score boost applier for recall queries.
 *
 * Classifies a free-text query into one of five intents and applies
 * type-specific confidence boosts so that the most relevant entry
 * types surface higher in re-ranked results.
 */


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryIntent =
  | "writing_code"
  | "debugging"
  | "conventions"
  | "history"
  | "general";

export type IntentBoostTable = {
  readonly [K in QueryIntent]: Readonly<Record<string, number>>;
};

// ---------------------------------------------------------------------------
// Boost table
// ---------------------------------------------------------------------------

/**
 * Per-intent boosts applied to base RRF scores.
 * Values are additive deltas capped at 1.0.
 */
export const INTENT_BOOSTS: IntentBoostTable = {
  debugging:    { error_pattern: 0.15, learning: 0.08 },
  writing_code: { convention: 0.10, decision: 0.08 },
  conventions:  { convention: 0.15 },
  history:      { decision: 0.12, ghost_knowledge: 0.15 },
  general:      {},
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/** First-match-wins ordered [regex, intent] pairs. */
const INTENT_PATTERNS: ReadonlyArray<readonly [RegExp, QueryIntent]> = [
  [/\b(fix|error|bug|failing|broken|crash|exception|throws|TypeError|undefined is not)\b/i, "debugging"],
  [/\b(naming|style|format|convention|lint|standard|consistent|pattern)\b/i, "conventions"],
  [/\b(why|who|when|history|changelog|decided|decision|rationale|motivation|policy|guidance|rule|protocol)\b/i, "history"],
  [/\b(write|create|add|implement|build|generate|scaffold|new)\b/i, "writing_code"],
] as const;

/**
 * Classifies a free-text query into a QueryIntent.
 *
 * Uses first-match-wins against an ordered list of regex patterns.
 * Returns "general" when no pattern matches (including empty string).
 */
export function classifyIntent(query: string): QueryIntent {
  for (const [pattern, intent] of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return intent;
    }
  }
  return "general";
}

// ---------------------------------------------------------------------------
// Boost applier
// ---------------------------------------------------------------------------

/**
 * Applies intent-based boosts to a map of entry scores.
 *
 * Returns a new Map — the input scores map is never mutated.
 * Scores are capped at 1.0. Entries absent from the scores map
 * start from a base of 0.0 before the boost is added.
 */
export function applyIntentBoost(
  entries: readonly { readonly id: string; readonly type: string }[],
  scores: ReadonlyMap<string, number>,
  intent: QueryIntent,
): Map<string, number> {
  const boosts = INTENT_BOOSTS[intent];
  return new Map(
    entries.map((e) => {
      const base = scores.get(e.id) ?? 0;
      const boost = boosts[e.type] ?? 0;
      return [e.id, Math.min(1.0, base + boost)] as const;
    }),
  );
}
