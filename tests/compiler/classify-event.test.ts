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
