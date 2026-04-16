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
