/**
 * Tests for checkFileViolations() — the convention violation engine.
 *
 * Uses an in-memory SQLite database seeded with synthetic conventions.
 * File content is passed directly (no disk I/O) via the optional third
 * argument of checkFileViolations.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { checkFileViolations } from "../../src/compiler/check-violations.js";

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a minimal convention entry with the given tags into the in-memory DB.
 * Returns the generated entry id.
 */
function seedConvention(
  title: string,
  tags: string[],
  scope: "team" | "project" | "personal" = "team",
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO entries
       (id, type, title, content, confidence, source_count, created_at,
        last_confirmed, status, scope)
     VALUES (?, 'convention', ?, '', 0.85, 1, ?, ?, 'active', ?)`,
    [id, title, now, now, scope],
  );

  for (const tag of tags) {
    db.run(
      "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
      [id, tag],
    );
  }

  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkFileViolations", () => {
  // -------------------------------------------------------------------------
  // 1. No conventions in DB -> empty result
  // -------------------------------------------------------------------------
  test("returns empty array when no conventions exist", () => {
    const result = checkFileViolations(
      db,
      "src/api/users.ts",
      "export const x = 1;",
    );
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. camelCase naming convention + PascalCase function -> warning
  // -------------------------------------------------------------------------
  test("camelCase convention flags PascalCase function name", () => {
    seedConvention("Naming: src/api uses camelCase functions", [
      "category:naming",
    ]);

    const content = `
export function GetUser() {
  return null;
}
`.trim();

    const result = checkFileViolations(db, "src/api/users.ts", content);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result.find((x) => x.message.includes("GetUser"));
    expect(v).toBeDefined();
    expect(v!.severity).toBe("warning");
    expect(v!.rule).toContain("camelCase");
  });

  // -------------------------------------------------------------------------
  // 3. Clean file with camelCase naming -> no violation
  // -------------------------------------------------------------------------
  test("camelCase convention passes clean file", () => {
    seedConvention("Naming: src/api uses camelCase functions", [
      "category:naming",
    ]);

    const content = `
export function getUser() {
  return null;
}
export function fetchUserById() {
  return null;
}
`.trim();

    const result = checkFileViolations(db, "src/api/clean.ts", content);
    // Filter to naming violations only.
    const naming = result.filter((v) => v.rule.includes("camelCase"));
    expect(naming).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. File naming convention (kebab-case) + PascalCase file -> error
  // -------------------------------------------------------------------------
  test("kebab-case file naming convention flags PascalCase filename", () => {
    seedConvention("File_naming: src uses kebab-case files", [
      "category:file_naming",
    ]);

    const result = checkFileViolations(
      db,
      "src/MyComponent.ts",
      "export const x = 1;",
    );

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result[0]!;
    expect(v.severity).toBe("error");
    expect(v.message).toContain("MyComponent.ts");
  });

  // -------------------------------------------------------------------------
  // 5. Imports order convention + external before builtin -> warning
  // -------------------------------------------------------------------------
  test("imports order convention flags external import before builtin", () => {
    seedConvention("Imports_order: src uses ordered imports", [
      "category:imports_order",
    ]);

    // zod (external) comes before path (builtin) — violates builtin-first rule.
    const content = [
      `import { z } from "zod";`,
      `import { join } from "path";`,
    ].join("\n");

    const result = checkFileViolations(db, "src/utils/foo.ts", content);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result.find((x) => x.severity === "warning");
    expect(v).toBeDefined();
    expect(v!.message).toContain("builtin");
  });

  // -------------------------------------------------------------------------
  // 6. Custom errors convention + bare throw new Error -> warning
  // -------------------------------------------------------------------------
  test("custom errors convention flags bare throw new Error", () => {
    seedConvention("Error_handling: src uses custom error classes", [
      "category:custom_errors",
    ]);

    const content = `
export function validate(x: unknown) {
  if (!x) {
    throw new Error("validation failed");
  }
}
`.trim();

    const result = checkFileViolations(db, "src/utils/validate.ts", content);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result[0]!;
    expect(v.severity).toBe("warning");
    expect(v.message).toContain("throw new Error");
  });

  // -------------------------------------------------------------------------
  // 7. Multiple conventions, clean file -> no violations
  // -------------------------------------------------------------------------
  test("multiple conventions produce no violations for a clean file", () => {
    seedConvention("Naming: src uses camelCase functions", ["category:naming"]);
    seedConvention("Imports_order: src uses ordered imports", [
      "category:imports_order",
    ]);
    seedConvention("Error_handling: src uses custom error classes", [
      "category:custom_errors",
    ]);

    // Clean file: camelCase function, correct import order, custom error throw.
    const content = [
      `import { join } from "path";`,
      `import { z } from "zod";`,
      `import { myHelper } from "./helper.js";`,
      ``,
      `export function doSomething() {`,
      `  throw new ValidationError("oops");`,
      `}`,
    ].join("\n");

    const result = checkFileViolations(db, "src/utils/doSomething.ts", content);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 8. Severity sort: errors before warnings before info
  // -------------------------------------------------------------------------
  test("violations are sorted errors first, then warnings, then info", () => {
    // file_naming -> error when basename is PascalCase
    seedConvention("File_naming: src uses kebab-case files", [
      "category:file_naming",
    ]);
    // naming -> warning for PascalCase function name
    seedConvention("Naming: src uses camelCase functions", ["category:naming"]);
    // exports -> info when named exports present and convention expects default
    seedConvention("Exports: src uses default exports", ["category:exports"]);

    // File: PascalCase name, PascalCase function, named export -> triggers all three.
    const content = `
export function MyFunc() {
  return null;
}
`.trim();

    const result = checkFileViolations(db, "src/MyFile.ts", content);

    // Must have at least one of each severity.
    const severities = result.map((v) => v.severity);
    const firstError = severities.indexOf("error");
    const firstWarning = severities.indexOf("warning");
    const firstInfo = severities.indexOf("info");

    // All three severities should be present.
    expect(firstError).not.toBe(-1);
    expect(firstWarning).not.toBe(-1);
    expect(firstInfo).not.toBe(-1);

    // errors must all come before any warning or info.
    const lastError = severities.lastIndexOf("error");
    expect(lastError).toBeLessThan(firstWarning);
    expect(lastError).toBeLessThan(firstInfo);
  });

  // -------------------------------------------------------------------------
  // 9. Named export convention flags export default
  // -------------------------------------------------------------------------
  test("named exports convention flags export default", () => {
    seedConvention("Exports: src uses named exports", ["category:exports"]);

    const content = `
const handler = () => {};
export default handler;
`.trim();

    const result = checkFileViolations(db, "src/handler.ts", content);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result.find((x) => x.message.includes("export default"));
    expect(v).toBeDefined();
    expect(v!.severity).toBe("warning");
  });

  // -------------------------------------------------------------------------
  // 10. Error handling (try/catch) convention + .catch usage -> info
  // -------------------------------------------------------------------------
  test("try/catch convention flags .catch() usage when no try block present", () => {
    seedConvention("Error_handling: src uses try/catch style", [
      "category:error_handling",
    ]);

    const content = `
export function run() {
  fetch("/api")
    .catch((err) => console.error(err));
}
`.trim();

    const result = checkFileViolations(db, "src/run.ts", content);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const v = result[0]!;
    expect(v.severity).toBe("info");
    expect(v.message).toContain(".catch()");
  });

  // -------------------------------------------------------------------------
  // 11. Violation count accuracy with two bare throws
  // -------------------------------------------------------------------------
  test("custom errors convention emits one warning per bare throw", () => {
    seedConvention("Error_handling: src uses custom error classes", [
      "category:custom_errors",
    ]);

    const content = `
export function a() { throw new Error("a"); }
export function b() { throw new Error("b"); }
`.trim();

    const result = checkFileViolations(
      db,
      "src/utils/multi.ts",
      content,
    );

    const warnings = result.filter((v) => v.severity === "warning");
    expect(warnings.length).toBe(2);
  });
});
