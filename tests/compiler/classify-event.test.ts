import { test, expect } from "bun:test";
import { classifyEvent } from "../../src/compiler/classify-event.js";

test("high-signal convention-like prompt scores >= 0.7 and team scope", () => {
  const r = classifyEvent({ type: "prompt", payload: { text: "we always use camelCase for identifiers" } });
  expect(r.signalStrength).toBeGreaterThanOrEqual(0.7);
  expect(r.scopeHint).toBe("team");
  expect(r.candidateType).toBe("convention");
});

test("low-signal casual prompt scores < 0.3 and personal scope", () => {
  const r = classifyEvent({ type: "prompt", payload: { text: "fix the bug" } });
  expect(r.signalStrength).toBeLessThan(0.3);
  expect(r.scopeHint).toBe("personal");
});

test("decision-phrased prompt is classified decision and team", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we decided to use postgres because we need json queries" },
  });
  expect(r.candidateType).toBe("decision");
  expect(r.scopeHint).toBe("team");
});

test("error tool_use event is classified as error_pattern candidate", () => {
  const r = classifyEvent({
    type: "tool_use",
    payload: { tool: "Bash", error: "Error: ENOENT no such file /foo.txt" },
  });
  expect(r.candidateType).toBe("error_pattern");
  expect(r.signalStrength).toBeGreaterThan(0.4);
});

test("session_start event scores 0 signal (boundary marker only)", () => {
  const r = classifyEvent({ type: "session_start", payload: {} });
  expect(r.signalStrength).toBe(0);
  expect(r.candidateType).toBeNull();
});

test("commit event becomes a learning candidate with moderate signal", () => {
  const r = classifyEvent({
    type: "commit",
    payload: { message: "feat(auth): enforce TOTP on admin routes" },
  });
  expect(r.candidateType).toBe("learning");
  expect(r.signalStrength).toBeGreaterThan(0.3);
});

test("convention words alone (no team signal) do not promote to convention candidate", () => {
  // Regression: single-OR logic previously promoted any camelCase mention
  // to a high-confidence convention entry, bloating the convention folder.
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "why is this using camelCase here" },
  });
  expect(r.candidateType).not.toBe("convention");
});

test("decision-phrased prompt without 'we' still becomes decision candidate (loosened)", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "the rationale is that postgres handles json better than mongo for this workload" },
  });
  expect(r.candidateType).toBe("decision");
  expect(r.signalStrength).toBeGreaterThanOrEqual(0.6);
});

// ─── Reject filter pack ────────────────────────────────────────────────
// These cases used to promote to convention/decision/learning because
// they hit TEAM_SIGNAL + CONVENTION/DECISION patterns. The filter pack
// short-circuits them BEFORE positive matching.

test("question with trailing ? is rejected even when it mentions camelCase", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "should we use camelCase or snake_case for constants?" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-question");
});

test("interrogative + 'we' opening rejects even without trailing ?", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "could we standardise on pnpm workspaces instead of bun" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-question");
});

test("historical 'we used to' rejects as null", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we used to use snake_case but migrated to camelCase last year" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-historical");
});

test("historical 'we stopped ... because' rejects as null (no decision)", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we stopped mocking the DB in integration tests because prod kept drifting" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-historical");
});

test("'anymore' marker rejects even with assertive phrasing", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we don't use class components in React anymore" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-historical");
});

test("soft qualifier 'usually' rejects convention candidacy", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we usually go camelCase but there are exceptions" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-soft-qualifier");
});

test("explicit 'not a rule' phrase rejects", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we often prefer const over let but it's not a rule" },
  });
  expect(r.candidateType).toBeNull();
  expect(r.ruleIds).toContain("prompt-soft-qualifier");
});

test("positive convention anchor still classifies as convention (no regression)", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we always use camelCase for function names in this repo" },
  });
  expect(r.candidateType).toBe("convention");
  expect(r.scopeHint).toBe("team");
});

test("code-grounded prompts are boosted over bare natural-language prompts of similar length", () => {
  // When the enrichment step attaches promptContext with files/symbols,
  // classifier weighs the prompt as code-grounded learning.
  const bare = classifyEvent({
    type: "prompt",
    payload: { text: "this is a reasonably long prompt but has nothing concrete in it at all here" },
  });
  const grounded = classifyEvent({
    type: "prompt",
    payload: {
      text: "this is a reasonably long prompt about the auth flow in our system here",
      promptContext: { files: ["src/auth/middleware.ts"], symbols: ["handleSessionTimeout"] },
    },
  });
  expect(grounded.signalStrength).toBeGreaterThan(bare.signalStrength);
});
