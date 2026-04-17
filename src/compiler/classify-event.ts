/**
 * Rule-based event classifier (Stage 1 of the parsing pipeline).
 *
 * Takes a raw event row and returns a classification verdict:
 *   - signalStrength:  0..1 — likelihood this event carries durable knowledge
 *   - scopeHint:       'personal' | 'team' | 'uncertain'
 *   - candidateType:   which entry type this event could become, or null
 *
 * Pure function. No I/O. No DB access. Safe for batch processing.
 */

export type EntryType = "convention" | "decision" | "learning" | "error_pattern" | "ghost_knowledge";
export type ScopeHint = "personal" | "team" | "uncertain";

export interface RawEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface Classification {
  readonly signalStrength: number;
  readonly scopeHint: ScopeHint;
  readonly candidateType: EntryType | null;
  /**
   * Stable identifiers for every rule that contributed to this verdict.
   * Empty when no rule fired (e.g. low-signal prompts).
   * Surfaced on the dashboard "Why?" affordance so users can audit
   * classification decisions.
   */
  readonly ruleIds: readonly string[];
  /**
   * Free-form reasoning string — only populated when the optional Stage 3
   * LLM distill runs. Remains absent for pure rule verdicts.
   */
  readonly reasoning?: string;
}

const TEAM_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\b(always|never)\s+(use|write|call|prefer)/i,
  /\bwe (use|prefer|decided|chose|standardi[sz]e)/i,
  /\b(convention|standard|policy|guideline)\b/i,
  /\bmust\s+(be|not|use|follow)/i,
];

const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(we )?(decided|chose|picked|went with|settled on)\b/i,
  /\bbecause\b/i,
  /\brationale\b/i,
];

const CONVENTION_PATTERNS: readonly RegExp[] = [
  /\b(camel|snake|pascal|kebab)[- ]?case\b/i,
  /\bnaming convention\b/i,
  /\b(always|never)\s+(use|write|import|export)\b/i,
];

const ERROR_TOKENS: readonly string[] = [
  "error",
  "exception",
  "failed",
  "traceback",
  "ENOENT",
  "EACCES",
  "segfault",
];

const LOW_SIGNAL_PROMPTS: readonly RegExp[] = [
  /^(ok|okay|yes|no|sure|keep going|continue|proceed|do it|go)\.?$/i,
  /^(fix (the|this)? (bug|issue))\.?$/i,
  /^(try again|retry|run it)\.?$/i,
  /^(thanks?|cool|nice|great)\.?$/i,
];

// Reject filters run BEFORE any positive-signal rule. Without them,
// "should we use camelCase?" hits both TEAM_SIGNAL and CONVENTION_PATTERN
// and promotes a *question* into a team convention — the exact bloat
// failure mode the adversarial fixture was built to pin down.

// Interrogatives — trailing '?' or an interrogative + "we" opening. The
// second form catches "could we standardise on pnpm" (no '?', but still
// a proposal not an assertion).
const QUESTION_PATTERNS: readonly RegExp[] = [
  /\?\s*$/,
  /^\s*(should|could|would|can|does|did|how|why|when|where|which|who)\s+we\b/i,
];

// Historical/past-tense statements — describe what WAS true, not what
// the current convention is. "we used to X" is not a convention to adopt.
const HISTORICAL_PATTERNS: readonly RegExp[] = [
  /\b(we|they|i)\s+used\s+to\b/i,
  /\b(we|they|i)\s+stopped\b/i,
  /\banymore\b/i,
  /\bmoved\s+(away\s+from|from)\b/i,
  /\bback\s+when\b/i,
  /\b(last|two|three|several)\s+(year|quarter|quarters|month|months|sprint|sprints)\s+ago\b/i,
  /\b(previously|formerly)\b/i,
];

// Soft qualifiers make an assertion non-binding — "usually", "sometimes",
// explicit "not a rule". These shouldn't surface as hard conventions even
// if CONVENTION_PATTERN matches downstream.
const SOFT_QUALIFIER_PATTERNS: readonly RegExp[] = [
  /\b(sometimes|usually|often|occasionally|typically|generally|mostly)\b/i,
  /\btends?\s+to\b/i,
  /\bnot\s+a\s+(hard\s+)?(rule|convention|standard)\b/i,
  /\bit\s+varies\b/i,
  /\b(but\s+)?(there\s+are\s+)?exceptions?\b/i,
];

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

/**
 * Stable rule identifiers surfaced alongside every verdict.
 * Renaming these is a breaking change for the dashboard's "Why?" view —
 * update the friendly-name map in the dashboard in lockstep.
 */
const RULE_IDS = {
  LOW_SIGNAL_PROMPT: "prompt-low-signal",
  TEAM_SIGNAL: "prompt-team-signal",
  CONVENTION_PATTERN: "prompt-convention-pattern",
  DECISION_PATTERN: "prompt-decision-pattern",
  DECISION_LONG: "prompt-decision-long",
  LEARNING_CODE_GROUNDED: "prompt-learning-code-grounded",
  LEARNING_LONG_TEXT: "prompt-learning-long",
  TOOL_USE_ERROR: "tool-use-error",
  COMMIT_CHORE: "commit-chore-style",
  COMMIT_MEANINGFUL: "commit-meaningful",
  MD_CHANGE_GENERIC: "md-change-generic",
  ADR_PATH: "plan-adr-path",
  PLAN_DOC: "plan-doc",
  UNKNOWN_TYPE: "event-unknown-type",
  EMPTY_PROMPT: "prompt-empty",
  EMPTY_COMMIT: "commit-empty",
  NON_CARRIER_EVENT: "event-non-carrier",
  QUESTION: "prompt-question",
  HISTORICAL: "prompt-historical",
  SOFT_QUALIFIER: "prompt-soft-qualifier",
} as const;

interface PromptContext {
  readonly files: readonly string[];
  readonly symbols: readonly string[];
}

function readPromptContext(payload: Record<string, unknown>): PromptContext {
  const raw = payload.promptContext;
  if (!raw || typeof raw !== "object") return { files: [], symbols: [] };
  const obj = raw as { files?: unknown; symbols?: unknown };
  const files = Array.isArray(obj.files) ? obj.files.filter((f): f is string => typeof f === "string") : [];
  const symbols = Array.isArray(obj.symbols) ? obj.symbols.filter((s): s is string => typeof s === "string") : [];
  return { files, symbols };
}

function classifyPrompt(text: string, ctx: PromptContext): Classification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      signalStrength: 0,
      scopeHint: "uncertain",
      candidateType: null,
      ruleIds: [RULE_IDS.EMPTY_PROMPT],
    };
  }
  if (anyMatch(LOW_SIGNAL_PROMPTS, trimmed)) {
    return {
      signalStrength: 0.1,
      scopeHint: "personal",
      candidateType: null,
      ruleIds: [RULE_IDS.LOW_SIGNAL_PROMPT],
    };
  }

  // Reject filters — take precedence over positive signals below.
  // Order matters: question first (cheapest test), then historical,
  // then soft qualifier. Each returns a low non-zero signal so the
  // event is still recorded in the activity log, just not promoted.
  if (anyMatch(QUESTION_PATTERNS, trimmed)) {
    return {
      signalStrength: 0.1,
      scopeHint: "uncertain",
      candidateType: null,
      ruleIds: [RULE_IDS.QUESTION],
    };
  }
  if (anyMatch(HISTORICAL_PATTERNS, trimmed)) {
    return {
      signalStrength: 0.1,
      scopeHint: "uncertain",
      candidateType: null,
      ruleIds: [RULE_IDS.HISTORICAL],
    };
  }
  if (anyMatch(SOFT_QUALIFIER_PATTERNS, trimmed)) {
    return {
      signalStrength: 0.15,
      scopeHint: "uncertain",
      candidateType: null,
      ruleIds: [RULE_IDS.SOFT_QUALIFIER],
    };
  }

  const hasTeamSignal = anyMatch(TEAM_SIGNAL_PATTERNS, trimmed);
  const isConvention = anyMatch(CONVENTION_PATTERNS, trimmed);
  const isDecision = anyMatch(DECISION_PATTERNS, trimmed);
  // Code-grounded prompts reference actual files or symbols; they carry
  // more durable signal than bare natural-language chatter of the same length.
  const codeGrounded = ctx.files.length > 0 || ctx.symbols.length > 0;

  // Accumulate every rule that fired — the verdict below picks the highest
  // precedence candidateType, but downstream stages (graphify rerank, LLM
  // distill) need the full list to decide whether to demote a duplicate.
  const firedRules: string[] = [];
  if (hasTeamSignal) firedRules.push(RULE_IDS.TEAM_SIGNAL);
  if (isConvention) firedRules.push(RULE_IDS.CONVENTION_PATTERN);
  if (isDecision) firedRules.push(RULE_IDS.DECISION_PATTERN);
  if (codeGrounded) firedRules.push(RULE_IDS.LEARNING_CODE_GROUNDED);

  // Convention requires team signal AND a convention pattern (tightens from
  // the prior single-OR which was the source of convention-folder bloat).
  if (isConvention && hasTeamSignal) {
    return {
      signalStrength: 0.85,
      scopeHint: "team",
      candidateType: "convention",
      ruleIds: firedRules,
    };
  }
  if (isDecision && hasTeamSignal) {
    return {
      signalStrength: 0.8,
      scopeHint: "team",
      candidateType: "decision",
      ruleIds: firedRules,
    };
  }
  // Loosen decisions: an explicit decision phrase alone (rationale / chose / because)
  // is enough to qualify as a decision candidate when the prompt is non-trivial.
  if (isDecision && trimmed.length > 40) {
    return {
      signalStrength: 0.65,
      scopeHint: "uncertain",
      candidateType: "decision",
      ruleIds: [...firedRules, RULE_IDS.DECISION_LONG],
    };
  }
  if (hasTeamSignal) {
    return {
      signalStrength: 0.7,
      scopeHint: "team",
      candidateType: "learning",
      ruleIds: firedRules,
    };
  }
  if (codeGrounded && trimmed.length > 40) {
    return {
      signalStrength: 0.55,
      scopeHint: "uncertain",
      candidateType: "learning",
      ruleIds: firedRules,
    };
  }
  if (trimmed.length > 120) {
    return {
      signalStrength: 0.4,
      scopeHint: "uncertain",
      candidateType: "learning",
      ruleIds: [...firedRules, RULE_IDS.LEARNING_LONG_TEXT],
    };
  }
  return {
    signalStrength: 0.2,
    scopeHint: "personal",
    candidateType: null,
    ruleIds: firedRules,
  };
}

function classifyToolUse(payload: Record<string, unknown>): Classification {
  const error = typeof payload.error === "string" ? payload.error : "";
  const hasError =
    error.length > 0 &&
    ERROR_TOKENS.some((t) => error.toLowerCase().includes(t.toLowerCase()));
  if (hasError) {
    return {
      signalStrength: 0.55,
      scopeHint: "uncertain",
      candidateType: "error_pattern",
      ruleIds: [RULE_IDS.TOOL_USE_ERROR],
    };
  }
  return { signalStrength: 0.1, scopeHint: "personal", candidateType: null, ruleIds: [] };
}

function classifyCommit(payload: Record<string, unknown>): Classification {
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length === 0) {
    return {
      signalStrength: 0.1,
      scopeHint: "uncertain",
      candidateType: null,
      ruleIds: [RULE_IDS.EMPTY_COMMIT],
    };
  }
  if (/^(chore|style|wip)/i.test(msg)) {
    return {
      signalStrength: 0.15,
      scopeHint: "personal",
      candidateType: null,
      ruleIds: [RULE_IDS.COMMIT_CHORE],
    };
  }
  return {
    signalStrength: 0.45,
    scopeHint: "team",
    candidateType: "learning",
    ruleIds: [RULE_IDS.COMMIT_MEANINGFUL],
  };
}

/**
 * Classifies a raw event. Never throws.
 */
export function classifyEvent(ev: RawEvent): Classification {
  const payload = ev.payload ?? {};
  switch (ev.type) {
    case "prompt": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return classifyPrompt(text, readPromptContext(payload));
    }
    case "tool_use":
      return classifyToolUse(payload);
    case "commit":
      return classifyCommit(payload);
    case "md_change":
      // Generic .md edit — low signal by itself. plan_added covers the
      // interesting subset (ADRs, plans, PRDs). md_change is mostly a
      // "someone touched docs" marker for activity timelines.
      return {
        signalStrength: 0.2,
        scopeHint: "uncertain",
        candidateType: null,
        ruleIds: [RULE_IDS.MD_CHANGE_GENERIC],
      };
    case "plan_added": {
      // New or edited plan/ADR file. Route type by path — ADR → decision,
      // plan/PRD → learning. Always team scope since these live in git.
      const path = typeof payload.path === "string" ? payload.path : "";
      if (path.startsWith("decisions/") || path.includes("/decisions/")) {
        return {
          signalStrength: 0.85,
          scopeHint: "team",
          candidateType: "decision",
          ruleIds: [RULE_IDS.ADR_PATH],
        };
      }
      return {
        signalStrength: 0.7,
        scopeHint: "team",
        candidateType: "learning",
        ruleIds: [RULE_IDS.PLAN_DOC],
      };
    }
    case "session_start":
    case "session_end":
    case "pre_compact":
    case "pull":
      return {
        signalStrength: 0,
        scopeHint: "uncertain",
        candidateType: null,
        ruleIds: [RULE_IDS.NON_CARRIER_EVENT],
      };
    default:
      return {
        signalStrength: 0,
        scopeHint: "uncertain",
        candidateType: null,
        ruleIds: [RULE_IDS.UNKNOWN_TYPE],
      };
  }
}

/**
 * Export the rule ID map so the dashboard and other consumers can render
 * friendly names without stringly-typed drift.
 */
export { RULE_IDS };
