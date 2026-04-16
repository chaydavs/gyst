import { describe, test, expect } from "bun:test";
import { normaliseHookPayload } from "../../src/store/events.js";

describe("normaliseHookPayload", () => {
  test("maps Claude Code UserPromptSubmit hook JSON to canonical shape", () => {
    const raw = {
      session_id: "abc-123",
      hook_event_name: "UserPromptSubmit",
      prompt: "we always use camelCase",
      cwd: "/repo",
    };
    const out = normaliseHookPayload("prompt", raw);
    expect(out.sessionId).toBe("abc-123");
    expect(out.text).toBe("we always use camelCase");
    expect(out.prompt).toBe("we always use camelCase"); // originals preserved
  });

  test("maps Claude Code PostToolUse hook JSON to tool + error", () => {
    const raw = {
      session_id: "xyz",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { is_error: true, content: "Error: TS2322 Type 'string' not assignable to 'number'" },
    };
    const out = normaliseHookPayload("tool_use", raw);
    expect(out.sessionId).toBe("xyz");
    expect(out.tool).toBe("Bash");
    expect(out.error).toBe("Error: TS2322 Type 'string' not assignable to 'number'");
  });

  test("idempotent — running twice yields the same result", () => {
    const once = normaliseHookPayload("prompt", { session_id: "s", prompt: "hi" });
    const twice = normaliseHookPayload("prompt", once);
    expect(twice).toEqual(once);
  });

  test("does not overwrite pre-normalized fields", () => {
    const raw = {
      session_id: "should-not-overwrite",
      sessionId: "explicit-camel",
      prompt: "raw",
      text: "explicit-text",
    };
    const out = normaliseHookPayload("prompt", raw);
    expect(out.sessionId).toBe("explicit-camel");
    expect(out.text).toBe("explicit-text");
  });

  test("extracts error from tool_response.stderr when is_error is absent", () => {
    const raw = {
      tool_name: "Bash",
      tool_response: { stderr: "command not found: foo" },
    };
    const out = normaliseHookPayload("tool_use", raw);
    expect(out.error).toBe("command not found: foo");
  });

  test("no-op for event types without mapping rules", () => {
    const raw = { session_id: "s", path: "docs/x.md" };
    const out = normaliseHookPayload("md_change", raw);
    expect(out.sessionId).toBe("s");
    expect(out.path).toBe("docs/x.md");
  });
});
