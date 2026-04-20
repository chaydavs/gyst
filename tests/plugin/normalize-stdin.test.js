import { test, expect } from "bun:test";
import { normalizeHookInput } from "../../plugin/scripts/normalize-stdin.js";

test("Claude Code / Codex shape — passes through unchanged", () => {
  const raw = {
    session_id: "sess-1",
    tool_name: "Read",
    transcript_path: "/tmp/t.jsonl",
    prompt: "hello",
    stop_hook_active: true,
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-1");
  expect(result.tool_name).toBe("Read");
  expect(result.transcript_path).toBe("/tmp/t.jsonl");
  expect(result.prompt_text).toBe("hello");
  expect(result.stop_hook_active).toBe(true);
});

test("Cursor camelCase shape — normalizes to snake_case", () => {
  const raw = {
    sessionId: "sess-2",
    toolName: "edit_file",
    transcriptPath: "/tmp/t2.jsonl",
    promptText: "world",
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-2");
  expect(result.tool_name).toBe("edit_file");
  expect(result.transcript_path).toBe("/tmp/t2.jsonl");
  expect(result.prompt_text).toBe("world");
  expect(result.stop_hook_active).toBe(false);
});

test("Windsurf shape — maps 'tool' to tool_name", () => {
  const raw = {
    session_id: "sess-3",
    tool: "shell",
  };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBe("sess-3");
  expect(result.tool_name).toBe("shell");
  expect(result.transcript_path).toBeNull();
  expect(result.prompt_text).toBeNull();
});

test("empty input — all fields null / false", () => {
  const result = normalizeHookInput({});
  expect(result.session_id).toBeNull();
  expect(result.tool_name).toBeNull();
  expect(result.transcript_path).toBeNull();
  expect(result.prompt_text).toBeNull();
  expect(result.stop_hook_active).toBe(false);
});

test("non-string values are coerced to null", () => {
  const raw = { session_id: 42, tool_name: null };
  const result = normalizeHookInput(raw);
  expect(result.session_id).toBeNull();
  expect(result.tool_name).toBeNull();
});

test("cwd and tool_input are extracted", () => {
  const raw = {
    session_id: "s1",
    cwd: "/home/user/project",
    tool_input: { file_path: "/src/foo.ts" },
  };
  const result = normalizeHookInput(raw);
  expect(result.cwd).toBe("/home/user/project");
  expect(result.tool_input).toEqual({ file_path: "/src/foo.ts" });
});

test("Cursor toolInput field is normalized", () => {
  const raw = { toolInput: { content: "hello" } };
  const result = normalizeHookInput(raw);
  expect(result.tool_input).toEqual({ content: "hello" });
});
