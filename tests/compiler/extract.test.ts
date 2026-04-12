import { describe, test, expect } from "bun:test";
import { extractEntry } from "../../src/compiler/extract.js";
import type { LearnInput } from "../../src/compiler/extract.js";
import { ValidationError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(overrides: Partial<LearnInput> = {}): LearnInput {
  return {
    type: "learning",
    title: "Always use strict equality",
    content:
      "Use === instead of == to avoid type coercion surprises in JavaScript.",
    files: [],
    tags: [],
    ...overrides,
  };
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Valid input → KnowledgeEntry shape
// ---------------------------------------------------------------------------

describe("extractEntry — valid input", () => {
  test("returns an object with a UUID id", () => {
    const entry = extractEntry(validInput());
    expect(entry.id).toMatch(UUID_REGEX);
  });

  test("id is unique across calls", () => {
    const a = extractEntry(validInput());
    const b = extractEntry(validInput());
    expect(a.id).not.toBe(b.id);
  });

  test("preserves type from input", () => {
    const entry = extractEntry(validInput({ type: "convention" }));
    expect(entry.type).toBe("convention");
  });

  test("preserves title from input", () => {
    const input = validInput({ title: "Prefer const over let" });
    const entry = extractEntry(input);
    expect(entry.title).toBe("Prefer const over let");
  });

  test("status defaults to active", () => {
    const entry = extractEntry(validInput());
    expect(entry.status).toBe("active");
  });

  test("sourceCount defaults to 1", () => {
    const entry = extractEntry(validInput());
    expect(entry.sourceCount).toBe(1);
  });

  test("confidence defaults to 0.5 when not supplied", () => {
    const entry = extractEntry(validInput());
    expect(entry.confidence).toBe(0.5);
  });

  test("confidence is preserved when explicitly provided", () => {
    const entry = extractEntry(validInput({ confidence: 0.9 }));
    expect(entry.confidence).toBe(0.9);
  });

  test("files array is preserved", () => {
    const entry = extractEntry(
      validInput({ files: ["src/app.ts", "src/utils.ts"] }),
    );
    expect(entry.files).toEqual(["src/app.ts", "src/utils.ts"]);
  });

  test("tags array is preserved", () => {
    const entry = extractEntry(validInput({ tags: ["typescript", "style"] }));
    expect(entry.tags).toEqual(["typescript", "style"]);
  });

  test("createdAt is set to a valid ISO string", () => {
    const entry = extractEntry(validInput());
    expect(entry.createdAt).toBeDefined();
    expect(() => new Date(entry.createdAt!).toISOString()).not.toThrow();
  });

  test("lastConfirmed is set to a valid ISO string", () => {
    const entry = extractEntry(validInput());
    expect(entry.lastConfirmed).toBeDefined();
    expect(() => new Date(entry.lastConfirmed!).toISOString()).not.toThrow();
  });

  test("createdAt and lastConfirmed are the same at creation time", () => {
    const entry = extractEntry(validInput());
    expect(entry.createdAt).toBe(entry.lastConfirmed);
  });
});

// ---------------------------------------------------------------------------
// Invalid input → ValidationError
// ---------------------------------------------------------------------------

describe("extractEntry — invalid input", () => {
  test("throws ValidationError for missing type", () => {
    const bad = { title: "Valid title here", content: "Valid content here" };
    expect(() => extractEntry(bad as LearnInput)).toThrow(ValidationError);
  });

  test("throws ValidationError for invalid type value", () => {
    const bad = validInput({ type: "unknown_type" as LearnInput["type"] });
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });

  test("throws ValidationError for title too short (< 5 chars)", () => {
    const bad = validInput({ title: "Hi" });
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });

  test("throws ValidationError for title too long (> 200 chars)", () => {
    const bad = validInput({ title: "A".repeat(201) });
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });

  test("throws ValidationError for content too short (< 10 chars)", () => {
    const bad = validInput({ content: "Too short" });
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });

  test("throws ValidationError for content too long (> 5000 chars)", () => {
    const bad = validInput({ content: "A".repeat(5001) });
    expect(() => extractEntry(bad)).toThrow(ValidationError);
  });

  test("thrown ValidationError has code VALIDATION_ERROR", () => {
    const bad = validInput({ title: "Hi" });
    try {
      extractEntry(bad);
      throw new Error("Expected ValidationError was not thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      if (err instanceof ValidationError) {
        expect(err.code).toBe("VALIDATION_ERROR");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Security: sensitive data stripping
// ---------------------------------------------------------------------------

describe("extractEntry — sensitive data stripping", () => {
  test("strips AWS key from content", () => {
    const entry = extractEntry(
      validInput({
        content:
          "Use AKIAIOSFODNN7EXAMPLE when authenticating with AWS services for deployment.",
      }),
    );
    expect(entry.content).toContain("[REDACTED]");
    expect(entry.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("strips connection string from content", () => {
    const entry = extractEntry(
      validInput({
        content:
          "Connect using postgres://admin:secret@db.host/prod for all queries.",
      }),
    );
    expect(entry.content).toContain("[REDACTED]");
    expect(entry.content).not.toContain("postgres://admin:secret");
  });

  test("strips sensitive data from errorMessage field", () => {
    const entry = extractEntry(
      validInput({
        type: "error_pattern",
        errorMessage:
          "Auth failed for AKIAIOSFODNN7EXAMPLE at service endpoint.",
        errorType: "AuthError",
      }),
    );
    expect(entry.errorMessage).toContain("[REDACTED]");
    expect(entry.errorMessage).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("does not modify clean content", () => {
    const cleanContent =
      "Always use strict equality operators in JavaScript code.";
    const entry = extractEntry(validInput({ content: cleanContent }));
    expect(entry.content).toBe(cleanContent);
  });
});

// ---------------------------------------------------------------------------
// Error pattern: signature and fingerprint
// ---------------------------------------------------------------------------

describe("extractEntry — error_pattern entries", () => {
  test("sets errorSignature for error_pattern with errorMessage", () => {
    const entry = extractEntry(
      validInput({
        type: "error_pattern",
        errorMessage:
          "TypeError: Cannot read properties of undefined (reading 'length')",
        errorType: "TypeError",
        content:
          "This error occurs when accessing a property on undefined values.",
      }),
    );
    expect(entry.errorSignature).toBeDefined();
    expect(typeof entry.errorSignature).toBe("string");
  });

  test("sets fingerprint when both errorType and errorMessage are provided", () => {
    const entry = extractEntry(
      validInput({
        type: "error_pattern",
        errorMessage:
          "TypeError: Cannot read properties of undefined (reading 'length')",
        errorType: "TypeError",
        content:
          "This error occurs when accessing a property on undefined values.",
      }),
    );
    expect(entry.fingerprint).toBeDefined();
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("fingerprint is undefined when errorType is absent", () => {
    const entry = extractEntry(
      validInput({
        type: "error_pattern",
        errorMessage:
          "TypeError: Cannot read properties of undefined (reading 'length')",
        content:
          "This error occurs when accessing a property on undefined values.",
      }),
    );
    expect(entry.fingerprint).toBeUndefined();
  });

  test("errorSignature is undefined when errorMessage is absent", () => {
    const entry = extractEntry(
      validInput({
        type: "error_pattern",
        content:
          "Generic error pattern without a specific message to normalize.",
      }),
    );
    expect(entry.errorSignature).toBeUndefined();
  });

  test("same error on different machines produces same fingerprint", () => {
    const baseInput = {
      type: "error_pattern" as const,
      errorType: "TypeError",
      content: "Null pointer access, check variable before use.",
    };
    const entry1 = extractEntry(
      validInput({
        ...baseInput,
        errorMessage:
          "Cannot read property 'foo' of null at /home/alice/project/src/app.ts:10:5",
      }),
    );
    const entry2 = extractEntry(
      validInput({
        ...baseInput,
        errorMessage:
          "Cannot read property 'foo' of null at /home/bob/work/other/src/app.ts:10:5",
      }),
    );
    expect(entry1.fingerprint).toBe(entry2.fingerprint);
  });

  test("non-error types do not get fingerprint", () => {
    for (const type of ["convention", "decision", "learning"] as const) {
      const entry = extractEntry(validInput({ type }));
      expect(entry.fingerprint).toBeUndefined();
    }
  });

  test("non-error types do not get errorSignature", () => {
    for (const type of ["convention", "decision", "learning"] as const) {
      const entry = extractEntry(validInput({ type }));
      expect(entry.errorSignature).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Immutability: returned entry is a new object
// ---------------------------------------------------------------------------

describe("extractEntry — immutability", () => {
  test("modifying the returned files array does not affect a second call", () => {
    const input = validInput({ files: ["src/index.ts"] });
    const entry = extractEntry(input);
    (entry.files as string[]).push("injected.ts");
    // files on the entry should not bleed into the input
    expect(input.files).toEqual(["src/index.ts"]);
  });
});
