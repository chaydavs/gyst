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

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

function classifyPrompt(text: string): Classification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
  if (anyMatch(LOW_SIGNAL_PROMPTS, trimmed)) {
    return { signalStrength: 0.1, scopeHint: "personal", candidateType: null };
  }

  const hasTeamSignal = anyMatch(TEAM_SIGNAL_PATTERNS, trimmed);
  const isConvention = anyMatch(CONVENTION_PATTERNS, trimmed);
  const isDecision = anyMatch(DECISION_PATTERNS, trimmed);

  if (isConvention) {
    return { signalStrength: 0.85, scopeHint: "team", candidateType: "convention" };
  }
  if (isDecision && hasTeamSignal) {
    return { signalStrength: 0.8, scopeHint: "team", candidateType: "decision" };
  }
  if (hasTeamSignal) {
    return { signalStrength: 0.7, scopeHint: "team", candidateType: "learning" };
  }
  if (trimmed.length > 80) {
    return { signalStrength: 0.4, scopeHint: "uncertain", candidateType: "learning" };
  }
  return { signalStrength: 0.2, scopeHint: "personal", candidateType: null };
}

function classifyToolUse(payload: Record<string, unknown>): Classification {
  const error = typeof payload.error === "string" ? payload.error : "";
  const hasError =
    error.length > 0 &&
    ERROR_TOKENS.some((t) => error.toLowerCase().includes(t.toLowerCase()));
  if (hasError) {
    return { signalStrength: 0.55, scopeHint: "uncertain", candidateType: "error_pattern" };
  }
  return { signalStrength: 0.1, scopeHint: "personal", candidateType: null };
}

function classifyCommit(payload: Record<string, unknown>): Classification {
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length === 0) {
    return { signalStrength: 0.1, scopeHint: "uncertain", candidateType: null };
  }
  if (/^(chore|style|wip)/i.test(msg)) {
    return { signalStrength: 0.15, scopeHint: "personal", candidateType: null };
  }
  return { signalStrength: 0.45, scopeHint: "team", candidateType: "learning" };
}

/**
 * Classifies a raw event. Never throws.
 */
export function classifyEvent(ev: RawEvent): Classification {
  const payload = ev.payload ?? {};
  switch (ev.type) {
    case "prompt": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return classifyPrompt(text);
    }
    case "tool_use":
      return classifyToolUse(payload);
    case "commit":
      return classifyCommit(payload);
    case "session_start":
    case "session_end":
    case "pre_compact":
    case "pull":
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
    default:
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
}
