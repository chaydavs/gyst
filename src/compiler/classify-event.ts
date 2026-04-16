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
    return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
  if (anyMatch(LOW_SIGNAL_PROMPTS, trimmed)) {
    return { signalStrength: 0.1, scopeHint: "personal", candidateType: null };
  }

  const hasTeamSignal = anyMatch(TEAM_SIGNAL_PATTERNS, trimmed);
  const isConvention = anyMatch(CONVENTION_PATTERNS, trimmed);
  const isDecision = anyMatch(DECISION_PATTERNS, trimmed);
  // Code-grounded prompts reference actual files or symbols; they carry
  // more durable signal than bare natural-language chatter of the same length.
  const codeGrounded = ctx.files.length > 0 || ctx.symbols.length > 0;

  // Convention requires team signal AND a convention pattern (tightens from
  // the prior single-OR which was the source of convention-folder bloat).
  if (isConvention && hasTeamSignal) {
    return { signalStrength: 0.85, scopeHint: "team", candidateType: "convention" };
  }
  if (isDecision && hasTeamSignal) {
    return { signalStrength: 0.8, scopeHint: "team", candidateType: "decision" };
  }
  // Loosen decisions: an explicit decision phrase alone (rationale / chose / because)
  // is enough to qualify as a decision candidate when the prompt is non-trivial.
  if (isDecision && trimmed.length > 40) {
    return { signalStrength: 0.65, scopeHint: "uncertain", candidateType: "decision" };
  }
  if (hasTeamSignal) {
    return { signalStrength: 0.7, scopeHint: "team", candidateType: "learning" };
  }
  if (codeGrounded && trimmed.length > 40) {
    return { signalStrength: 0.55, scopeHint: "uncertain", candidateType: "learning" };
  }
  if (trimmed.length > 120) {
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
      return { signalStrength: 0.2, scopeHint: "uncertain", candidateType: null };
    case "plan_added": {
      // New or edited plan/ADR file. Route type by path — ADR → decision,
      // plan/PRD → learning. Always team scope since these live in git.
      const path = typeof payload.path === "string" ? payload.path : "";
      if (path.startsWith("decisions/") || path.includes("/decisions/")) {
        return { signalStrength: 0.85, scopeHint: "team", candidateType: "decision" };
      }
      return { signalStrength: 0.7, scopeHint: "team", candidateType: "learning" };
    }
    case "session_start":
    case "session_end":
    case "pre_compact":
    case "pull":
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
    default:
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
}
