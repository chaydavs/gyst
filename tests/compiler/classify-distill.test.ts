import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  distillWithLLM,
  resetDistillBudget,
} from "../../src/compiler/classify-distill.js";
import type { Classification } from "../../src/compiler/classify-event.js";

function verdict(partial: Partial<Classification>): Classification {
  return {
    signalStrength: 0.5,
    scopeHint: "uncertain",
    candidateType: "convention",
    ruleIds: ["prompt-team-signal"],
    ...partial,
  };
}

const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  resetDistillBudget();
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

function mockFetchJson(body: unknown, ok: boolean = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

test("no API key → returns input verdict, no network call", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let called = false;
  const mock: typeof fetch = async () => {
    called = true;
    return new Response();
  };
  const input = verdict({ signalStrength: 0.5 });
  const out = await distillWithLLM(input, { text: "foo" }, { fetchFn: mock });
  expect(out).toBe(input);
  expect(called).toBe(false);
});

test("non-borderline signal → skips LLM call", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  let called = false;
  const mock: typeof fetch = async () => {
    called = true;
    return new Response();
  };
  const input = verdict({ signalStrength: 0.9 });
  const out = await distillWithLLM(input, { text: "foo" }, { fetchFn: mock });
  expect(out).toBe(input);
  expect(called).toBe(false);
});

test("distiller amplifies when LLM picks a different type", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const body = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          type: "decision",
          reasoning: "migration choice with rationale",
        }),
      },
    ],
  };
  const out = await distillWithLLM(
    verdict({ candidateType: "convention", signalStrength: 0.48 }),
    { text: "we decided to migrate to Bun because startup speed matters" },
    { fetchFn: mockFetchJson(body) },
  );
  expect(out.candidateType).toBe("decision");
  expect(out.signalStrength).toBeGreaterThanOrEqual(0.6);
  expect(out.ruleIds).toContain("distill-amplified");
  expect(out.reasoning).toBe("migration choice with rationale");
});

test("distiller suppresses when LLM returns 'none'", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const body = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ type: "none", reasoning: "filler, no knowledge" }),
      },
    ],
  };
  const out = await distillWithLLM(
    verdict({ signalStrength: 0.5 }),
    { text: "thanks that helps" },
    { fetchFn: mockFetchJson(body) },
  );
  expect(out.candidateType).toBeNull();
  expect(out.signalStrength).toBeLessThan(0.4);
  expect(out.ruleIds).toContain("distill-suppressed");
});

test("distiller agrees path bumps signal above threshold", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const body = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ type: "convention", reasoning: "clear team norm" }),
      },
    ],
  };
  const out = await distillWithLLM(
    verdict({ candidateType: "convention", signalStrength: 0.48 }),
    { text: "we always use camelCase" },
    { fetchFn: mockFetchJson(body) },
  );
  expect(out.candidateType).toBe("convention");
  expect(out.signalStrength).toBeGreaterThanOrEqual(0.55);
  expect(out.ruleIds).toContain("distill-agreed");
});

test("network error returns input verdict", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const mock: typeof fetch = async () => {
    throw new Error("econnreset");
  };
  const input = verdict({ signalStrength: 0.5 });
  const out = await distillWithLLM(input, { text: "foo" }, { fetchFn: mock });
  expect(out).toBe(input);
});

test("budget cap exhausts after configured calls", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  resetDistillBudget(2);
  const body = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ type: "none", reasoning: "test" }),
      },
    ],
  };
  let callCount = 0;
  const mock: typeof fetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => body,
    } as unknown as Response;
  };
  await distillWithLLM(verdict({ signalStrength: 0.5 }), { text: "a" }, { fetchFn: mock });
  await distillWithLLM(verdict({ signalStrength: 0.5 }), { text: "b" }, { fetchFn: mock });
  const third = await distillWithLLM(
    verdict({ signalStrength: 0.5 }),
    { text: "c" },
    { fetchFn: mock },
  );
  expect(callCount).toBe(2);
  // Third call short-circuited — verdict unchanged.
  expect(third.candidateType).toBe("convention");
});

test("malformed JSON response falls back to input", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const body = {
    content: [{ type: "text", text: "not json at all" }],
  };
  const input = verdict({ signalStrength: 0.5 });
  const out = await distillWithLLM(input, { text: "foo" }, { fetchFn: mockFetchJson(body) });
  expect(out).toBe(input);
});
