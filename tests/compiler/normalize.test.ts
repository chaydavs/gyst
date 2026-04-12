import { describe, test, expect } from "bun:test";
import {
  normalizeErrorSignature,
  generateFingerprint,
} from "../../src/compiler/normalize.js";

// ---------------------------------------------------------------------------
// normalizeErrorSignature
// ---------------------------------------------------------------------------

describe("normalizeErrorSignature", () => {
  test("replaces absolute file paths with <PATH>", () => {
    const result = normalizeErrorSignature(
      "Error at /home/user/project/src/index.ts line 42",
    );
    expect(result).toContain("<path>");
    expect(result).not.toContain("/home/user/project/src/index.ts");
  });

  test("replaces relative file paths with <PATH>", () => {
    const result = normalizeErrorSignature("Cannot find module ./utils/helper.js");
    expect(result).toContain("<path>");
    expect(result).not.toContain("./utils/helper.js");
  });

  test("replaces line:col references with :<LINE>", () => {
    const result = normalizeErrorSignature("SyntaxError at line :42:7");
    expect(result).toContain(":<line>");
    expect(result).not.toMatch(/:\d+/);
  });

  test("replaces UUIDs with <UUID>", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = normalizeErrorSignature(`Entry ${uuid} not found`);
    expect(result).toContain("<uuid>");
    expect(result).not.toContain(uuid);
  });

  test("replaces ISO-8601 timestamps with <TS>", () => {
    const ts = "2024-03-15T10:30:45.123Z";
    const result = normalizeErrorSignature(`Error at ${ts}`);
    expect(result).toContain("<ts>");
    expect(result).not.toContain(ts);
  });

  test("replaces timestamps without milliseconds", () => {
    const ts = "2024-03-15T10:30:45Z";
    const result = normalizeErrorSignature(`Logged at ${ts}`);
    expect(result).toContain("<ts>");
    expect(result).not.toContain(ts);
  });

  test("replaces URLs with <URL>", () => {
    const result = normalizeErrorSignature(
      "Failed to fetch https://api.example.com/v2/users/123",
    );
    expect(result).toContain("<url>");
    expect(result).not.toContain("https://api.example.com");
  });

  test("replaces http URLs", () => {
    const result = normalizeErrorSignature(
      "Request to http://localhost:3000/health failed",
    );
    expect(result).toContain("<url>");
    expect(result).not.toContain("http://localhost");
  });

  test("replaces bare numbers last (after specific patterns)", () => {
    // Numbers inside UUIDs/timestamps should already be replaced; bare numbers get <N>
    const result = normalizeErrorSignature("Process exited with code 137");
    expect(result).toContain("<n>");
    expect(result).not.toMatch(/\b137\b/);
  });

  test("lowercases the entire result", () => {
    const result = normalizeErrorSignature("TypeError: Cannot Read Property");
    expect(result).toBe(result.toLowerCase());
  });

  test("returns empty string for empty input", () => {
    expect(normalizeErrorSignature("")).toBe("");
  });

  test("returns unchanged (lowercased) string when nothing to replace", () => {
    const result = normalizeErrorSignature("null pointer exception");
    expect(result).toBe("null pointer exception");
  });

  test("handles nested quotes by replacing quoted strings", () => {
    const result = normalizeErrorSignature(`Cannot read property "foo" of undefined`);
    expect(result).toContain("<str>");
    expect(result).not.toContain('"foo"');
  });

  test("handles single-quoted strings", () => {
    const result = normalizeErrorSignature("Module 'lodash' not found");
    expect(result).toContain("<str>");
    expect(result).not.toContain("'lodash'");
  });

  test("same error on different machines produces same signature", () => {
    const machine1 = normalizeErrorSignature(
      "TypeError: Cannot read property 'length' of undefined at /home/alice/project/src/app.ts:42:7",
    );
    const machine2 = normalizeErrorSignature(
      "TypeError: Cannot read property 'length' of undefined at /home/bob/work/my-app/src/app.ts:42:7",
    );
    expect(machine1).toBe(machine2);
  });

  test("same error with different timestamps produces same signature", () => {
    const ts1 = normalizeErrorSignature(
      "Connection failed at 2024-01-01T00:00:00Z",
    );
    const ts2 = normalizeErrorSignature(
      "Connection failed at 2024-06-15T12:34:56.789Z",
    );
    expect(ts1).toBe(ts2);
  });

  test("same error with different UUIDs produces same signature", () => {
    const sig1 = normalizeErrorSignature(
      "Entry 550e8400-e29b-41d4-a716-446655440000 not found",
    );
    const sig2 = normalizeErrorSignature(
      "Entry ffffffff-ffff-4fff-bfff-ffffffffffff not found",
    );
    expect(sig1).toBe(sig2);
  });

  test("memory addresses replaced before generic numbers", () => {
    const result = normalizeErrorSignature("Segfault at 0x7ffd3e2a4b80");
    expect(result).toContain("<addr>");
    // The hex digits should not survive as bare <N> tokens
    expect(result).not.toContain("0x7ffd3e2a4b80");
  });

  test("specific patterns match before generic number replacement", () => {
    // UUID digits should become <UUID>, not a mix of <N> tokens
    const result = normalizeErrorSignature(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result).toBe("<uuid>");
  });
});

// ---------------------------------------------------------------------------
// generateFingerprint
// ---------------------------------------------------------------------------

describe("generateFingerprint", () => {
  test("returns a 16-character hexadecimal string", () => {
    const fp = generateFingerprint("TypeError", "cannot read property");
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test("same inputs always produce same fingerprint", () => {
    const fp1 = generateFingerprint("TypeError", "cannot read property");
    const fp2 = generateFingerprint("TypeError", "cannot read property");
    expect(fp1).toBe(fp2);
  });

  test("different error types produce different fingerprints", () => {
    const fp1 = generateFingerprint("TypeError", "cannot read property");
    const fp2 = generateFingerprint("RangeError", "cannot read property");
    expect(fp1).not.toBe(fp2);
  });

  test("different messages produce different fingerprints", () => {
    const fp1 = generateFingerprint("TypeError", "cannot read property");
    const fp2 = generateFingerprint("TypeError", "cannot set property");
    expect(fp1).not.toBe(fp2);
  });

  test("topFrame produces different fingerprint than without it", () => {
    const withoutFrame = generateFingerprint("TypeError", "cannot read property");
    const withFrame = generateFingerprint(
      "TypeError",
      "cannot read property",
      { file: "src/app.ts", function: "handleRequest" },
    );
    expect(withoutFrame).not.toBe(withFrame);
  });

  test("same topFrame with same inputs produces same fingerprint", () => {
    const frame = { file: "src/app.ts", function: "handleRequest" };
    const fp1 = generateFingerprint("TypeError", "cannot read property", frame);
    const fp2 = generateFingerprint("TypeError", "cannot read property", frame);
    expect(fp1).toBe(fp2);
  });

  test("different topFrame files produce different fingerprints", () => {
    const fp1 = generateFingerprint("TypeError", "msg", {
      file: "src/a.ts",
      function: "fn",
    });
    const fp2 = generateFingerprint("TypeError", "msg", {
      file: "src/b.ts",
      function: "fn",
    });
    expect(fp1).not.toBe(fp2);
  });

  test("different topFrame functions produce different fingerprints", () => {
    const fp1 = generateFingerprint("TypeError", "msg", {
      file: "src/a.ts",
      function: "funcA",
    });
    const fp2 = generateFingerprint("TypeError", "msg", {
      file: "src/a.ts",
      function: "funcB",
    });
    expect(fp1).not.toBe(fp2);
  });

  test("output is purely hexadecimal (no uppercase)", () => {
    const fp = generateFingerprint("SyntaxError", "unexpected token");
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });
});
