import { describe, test, expect } from "bun:test";
import { parseError } from "../../src/compiler/parsers/error.js";
import { extractContextFromPrompt } from "../../src/compiler/parsers/prompt.js";

describe("Improved Parsers (Zero-LLM)", () => {
  describe("Error Parser", () => {
    test("detects TypeScript errors from tsc output", () => {
      const output = "src/store/database.ts:42:7 - error TS2322: Type 'null' is not assignable to type 'string'.";
      const parsed = parseError(output);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("TS2322");
      expect(parsed?.file).toBe("src/store/database.ts");
      expect(parsed?.line).toBe(42);
      expect(parsed?.message).toBe("Type 'null' is not assignable to type 'string'.");
    });

    test("detects Node.js / V8 stack traces", () => {
      const output = "TypeError: Cannot read property 'id' of undefined\n    at handleRequest (/app/src/server.ts:15:20)\n    at Object.<anonymous> (/app/src/index.ts:10:5)";
      const parsed = parseError(output);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("TypeError");
      expect(parsed?.file).toBe("/app/src/server.ts");
      expect(parsed?.line).toBe(15);
      expect(parsed?.message).toBe("Cannot read property 'id' of undefined");
    });

    test("detects generic errors", () => {
      const output = "PrismaClientKnownRequestError: Unique constraint failed on the fields: (`email`)";
      const parsed = parseError(output);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe("PrismaClientKnownRequestError");
      expect(parsed?.message).toContain("Unique constraint failed");
    });

    test("returns null for non-error output", () => {
      const output = "Done in 1.2s. Output: 42";
      const parsed = parseError(output);
      expect(parsed).toBeNull();
    });
  });

  describe("Prompt Tracker", () => {
    test("extracts file paths from prompt", () => {
      const prompt = "Can you check the logic in src/api/users.ts and also look at package.json?";
      const context = extractContextFromPrompt(prompt);
      expect(context.files).toContain("src/api/users.ts");
      expect(context.files).toContain("package.json");
    });

    test("extracts backticked symbols", () => {
      const prompt = "How does the `validateToken` function work in the `AuthMiddleware`?";
      const context = extractContextFromPrompt(prompt);
      expect(context.symbols).toContain("validateToken");
      expect(context.symbols).toContain("AuthMiddleware");
    });

    test("extracts code-like tokens (camelCase/PascalCase)", () => {
      const prompt = "The UserProfile component is failing when calling fetchMetadataAsync.";
      const context = extractContextFromPrompt(prompt);
      expect(context.symbols).toContain("UserProfile");
      expect(context.symbols).toContain("fetchMetadataAsync");
    });

    test("deduplicates symbols", () => {
      const prompt = "Using `AuthService` and then `AuthService` again.";
      const context = extractContextFromPrompt(prompt);
      expect(context.symbols.length).toBe(1);
      expect(context.symbols).toContain("AuthService");
    });

    test("privacy: does not return the original text", () => {
      // The function itself doesn't return the text, we just verify the output object shape
      const prompt = "SECRET_KEY=12345";
      const context = extractContextFromPrompt(prompt);
      const stringified = JSON.stringify(context);
      expect(stringified).not.toContain(prompt);
      expect(context.files.length).toBe(0);
      expect(context.symbols.length).toBe(0);
    });
  });
});
