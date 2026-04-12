/**
 * Confidence scoring for Gyst knowledge entries.
 *
 * Confidence captures how trustworthy an entry is given:
 *  - How many independent sources have contributed to it (source saturation).
 *  - How recently the entry was confirmed (time decay with type-specific
 *    half-lives).
 *  - Whether contradicting entries exist (contradiction penalty).
 *  - Whether the referenced code has changed since the entry was created
 *    (code-change penalty).
 *
 * The final value is clamped to [0, 1].
 */

/** Entry types with their respective confidence-decay half-lives in days. */
const HALF_LIFE_DAYS: Record<string, number> = {
  /** Error patterns decay slowly — 30-day half-life. */
  error_pattern: 30,
  /**
   * Conventions are considered permanent; extremely large half-life
   * effectively prevents decay.
   */
  convention: 9_999,
  /** Architectural decisions have a 1-year half-life. */
  decision: 365,
  /** Learnings decay moderately — 60-day half-life. */
  learning: 60,
};

/** Multiplier applied when a contradicting entry exists. */
const CONTRADICTION_PENALTY = 0.5;

/** Multiplier applied when the associated source code has changed. */
const CODE_CHANGED_PENALTY = 0.7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * All factors required to compute the confidence score for a single entry.
 */
export interface ConfidenceFactors {
  /**
   * Entry type — one of: `"error_pattern"`, `"convention"`, `"decision"`,
   * `"learning"`.
   */
  readonly type: string;

  /** Number of independent sources that have confirmed this entry. */
  readonly sourceCount: number;

  /**
   * ISO-8601 date string of the last time the entry was confirmed as still
   * accurate.
   */
  readonly lastConfirmedAt: string;

  /**
   * The reference date for decay calculation.
   * Defaults to `new Date()` (i.e. "now") when omitted.
   */
  readonly now?: Date;

  /** Whether a contradicting entry exists in the knowledge base. */
  readonly hasContradiction: boolean;

  /**
   * Whether the source code referenced by this entry has changed since the
   * entry was created.
   */
  readonly codeChanged: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the confidence score for a knowledge entry.
 *
 * Formula:
 * ```
 * saturation  = 1 - 1 / (1 + sourceCount)
 * decay       = 0.5 ^ (daysSinceLastConfirmed / halfLife)
 * raw         = saturation * decay
 * penalised   = raw
 *               * (hasContradiction ? 0.5 : 1)
 *               * (codeChanged ? 0.7 : 1)
 * result      = clamp(penalised, 0, 1)
 * ```
 *
 * @param factors - The set of factors influencing confidence.
 * @returns A confidence value in [0, 1].
 */
export function calculateConfidence(factors: ConfidenceFactors): number {
  const {
    type,
    sourceCount,
    lastConfirmedAt,
    now = new Date(),
    hasContradiction,
    codeChanged,
  } = factors;

  // Source saturation: asymptotically approaches 1 as sources grow.
  // With 1 source → 0.5; 3 sources → 0.75; 9 sources → 0.9.
  const saturation = 1 - 1 / (1 + sourceCount);

  // Time decay using type-specific half-life
  const halfLife = HALF_LIFE_DAYS[type] ?? HALF_LIFE_DAYS["learning"];
  const lastConfirmedDate = new Date(lastConfirmedAt);
  const msPerDay = 24 * 60 * 60 * 1_000;
  const daysSince = (now.getTime() - lastConfirmedDate.getTime()) / msPerDay;

  // Prevent negative days (e.g. clock skew / future lastConfirmedAt)
  const effectiveDays = Math.max(0, daysSince);
  const decay = Math.pow(0.5, effectiveDays / halfLife);

  let score = saturation * decay;

  // Apply penalties multiplicatively (immutable — never modifying `score` in
  // place; reassigning to a new binding each step for clarity)
  const afterContradiction = hasContradiction
    ? score * CONTRADICTION_PENALTY
    : score;

  const afterCodeChange = codeChanged
    ? afterContradiction * CODE_CHANGED_PENALTY
    : afterContradiction;

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, afterCodeChange));
}
