/**
 * Tests for the three new detectors added to detectConventions():
 *   - file_naming
 *   - imports_order
 *   - custom_errors
 *
 * Also includes a smoke-test regression check to verify the original five
 * detectors still work after the extension.
 *
 * Each test builds a temporary directory with synthetic TypeScript files,
 * runs detectConventions(), then asserts on the returned array.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectConventions } from "../../src/compiler/detect-conventions.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gyst-ext-conv-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write `tempDir/<name>` with the given content. */
async function writeTs(name: string, content: string): Promise<void> {
  await writeFile(join(tempDir, name), content, "utf-8");
}

// ---------------------------------------------------------------------------
// file_naming detector
// ---------------------------------------------------------------------------

describe("file_naming detector", () => {
  test("detects kebab-case when 6 of 6 files use kebab-case names", async () => {
    const content = `export const x = 1;\n`;
    await writeTs("auth-service.ts", content);
    await writeTs("user-repository.ts", content);
    await writeTs("request-handler.ts", content);
    await writeTs("token-validator.ts", content);
    await writeTs("error-mapper.ts", content);
    await writeTs("session-store.ts", content);

    const conventions = await detectConventions(tempDir);

    const found = conventions.find(
      (c) =>
        c.category === "file_naming" && c.pattern === "kebab-case file naming",
    );

    expect(found).toBeDefined();
    expect(found!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(found!.evidence.filesScanned).toBe(6);
    expect(found!.evidence.filesMatching).toBe(6);
  });

  test("detects PascalCase when 6 of 6 files use PascalCase names", async () => {
    const content = `export class Service {}\n`;
    await writeTs("AuthService.ts", content);
    await writeTs("UserRepository.ts", content);
    await writeTs("RequestHandler.ts", content);
    await writeTs("TokenValidator.ts", content);
    await writeTs("ErrorMapper.ts", content);
    await writeTs("SessionStore.ts", content);

    const conventions = await detectConventions(tempDir);

    const found = conventions.find(
      (c) =>
        c.category === "file_naming" && c.pattern === "PascalCase file naming",
    );

    expect(found).toBeDefined();
    expect(found!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("no file_naming convention when mix of styles is below 70% threshold", async () => {
    // 2 kebab, 2 pascal, 2 camel — none reaches 70% of 6
    const content = `export const x = 1;\n`;
    await writeTs("auth-service.ts", content);
    await writeTs("user-repository.ts", content);
    await writeTs("AuthService.ts", content);
    await writeTs("UserRepository.ts", content);
    await writeTs("authService.ts", content);
    await writeTs("userRepository.ts", content);

    const conventions = await detectConventions(tempDir);

    const found = conventions.find((c) => c.category === "file_naming");
    expect(found).toBeUndefined();
  });

  test("confidence matches ratio when 5 of 6 files are kebab-case", async () => {
    const content = `export const x = 1;\n`;
    await writeTs("auth-service.ts", content);
    await writeTs("user-repository.ts", content);
    await writeTs("request-handler.ts", content);
    await writeTs("token-validator.ts", content);
    await writeTs("error-mapper.ts", content);
    // One PascalCase outlier
    await writeTs("AuthService.ts", content);

    const conventions = await detectConventions(tempDir);

    const found = conventions.find(
      (c) =>
        c.category === "file_naming" && c.pattern === "kebab-case file naming",
    );

    expect(found).toBeDefined();
    expect(found!.confidence).toBeCloseTo(5 / 6, 2);
    expect(found!.evidence.filesMatching).toBe(5);
    expect(found!.evidence.filesScanned).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// imports_order detector
// ---------------------------------------------------------------------------

describe("imports_order detector", () => {
  /** Well-ordered file: builtin → external → internal */
  const orderedContent = (n: number) =>
    `import { readFile } from 'fs';\n` +
    `import { z } from 'zod';\n` +
    `import { helper${n} } from './helper${n}.js';\n` +
    `export const fn${n} = () => {};\n`;

  /** Disordered file: internal before external */
  const disorderedContent = (n: number) =>
    `import { helper${n} } from './helper${n}.js';\n` +
    `import { z } from 'zod';\n` +
    `import { readFile } from 'fs';\n` +
    `export const fn${n} = () => {};\n`;

  test("detects ordered imports when 6 of 6 files are well-ordered", async () => {
    for (let i = 1; i <= 6; i++) {
      await writeTs(`module${i}.ts`, orderedContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find(
      (c) =>
        c.category === "imports_order" &&
        c.pattern === "imports ordered builtin→external→internal",
    );

    expect(found).toBeDefined();
    expect(found!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("no imports_order convention when files are consistently disordered", async () => {
    for (let i = 1; i <= 6; i++) {
      await writeTs(`module${i}.ts`, disorderedContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find((c) => c.category === "imports_order");
    expect(found).toBeUndefined();
  });

  test("files with fewer than 3 imports are excluded from the sample", async () => {
    // 6 files each have only 2 imports → all excluded → no detection
    const twoImportContent = (n: number) =>
      `import { z } from 'zod';\n` +
      `import { helper${n} } from './helper${n}.js';\n` +
      `export const fn${n} = () => {};\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`module${i}.ts`, twoImportContent(i));
    }

    const conventions = await detectConventions(tempDir);

    // Not enough qualifying files → no imports_order entry
    const found = conventions.find((c) => c.category === "imports_order");
    expect(found).toBeUndefined();
  });

  test("mixed order: 4 ordered + 2 disordered falls below 70% threshold", async () => {
    for (let i = 1; i <= 4; i++) {
      await writeTs(`ordered${i}.ts`, orderedContent(i));
    }
    for (let i = 1; i <= 2; i++) {
      await writeTs(`disordered${i}.ts`, disorderedContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find((c) => c.category === "imports_order");
    // 4/6 ≈ 0.67, below the 0.7 threshold
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// custom_errors detector
// ---------------------------------------------------------------------------

describe("custom_errors detector", () => {
  /** File that uses custom error classes more than bare Error */
  const customErrContent = (n: number) =>
    `export function doStuff${n}() {\n` +
    `  if (!x) throw new ValidationError('bad input');\n` +
    `  if (!y) throw new NotFoundError('missing resource');\n` +
    `}\n`;

  /** File that only throws bare Error */
  const bareErrContent = (n: number) =>
    `export function doStuff${n}() {\n` +
    `  if (!x) throw new Error('something went wrong');\n` +
    `}\n`;

  test("detects custom error classes when 6 of 6 files use them predominantly", async () => {
    for (let i = 1; i <= 6; i++) {
      await writeTs(`service${i}.ts`, customErrContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find(
      (c) =>
        c.category === "custom_errors" && c.pattern === "custom error classes",
    );

    expect(found).toBeDefined();
    expect(found!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("no custom_errors convention when all files throw bare Error only", async () => {
    for (let i = 1; i <= 6; i++) {
      await writeTs(`service${i}.ts`, bareErrContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find((c) => c.category === "custom_errors");
    expect(found).toBeUndefined();
  });

  test("no custom_errors convention when fewer than 5 files throw at all", async () => {
    // 4 files throw custom errors, 2 files have no throws
    for (let i = 1; i <= 4; i++) {
      await writeTs(`service${i}.ts`, customErrContent(i));
    }
    await writeTs("no-throw1.ts", `export const x = 1;\n`);
    await writeTs("no-throw2.ts", `export const y = 2;\n`);

    const conventions = await detectConventions(tempDir);

    // Only 4 files have throws → below MIN_FILES_PER_DIR=5 → no detection
    const found = conventions.find((c) => c.category === "custom_errors");
    expect(found).toBeUndefined();
  });

  test("confidence reflects ratio: 4 custom + 2 bare across 6 throw-files", async () => {
    for (let i = 1; i <= 4; i++) {
      await writeTs(`custom${i}.ts`, customErrContent(i));
    }
    for (let i = 1; i <= 2; i++) {
      await writeTs(`bare${i}.ts`, bareErrContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const found = conventions.find((c) => c.category === "custom_errors");
    // 4/6 ≈ 0.67, above the 0.6 threshold
    expect(found).toBeDefined();
    expect(found!.confidence).toBeCloseTo(4 / 6, 2);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing detectors still work
// ---------------------------------------------------------------------------

describe("regression — original detectors unaffected", () => {
  test("naming and imports detectors still emit results after the extension", async () => {
    const fileContent = (n: number) =>
      `import { helper${n} } from './utils';\n` +
      `export function getUserData${n}() { return null; }\n` +
      `export const fetchItems${n} = async () => [];\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`module${i}.ts`, fileContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const namingConv = conventions.find(
      (c) => c.category === "naming" && c.pattern === "camelCase functions",
    );
    const importConv = conventions.find(
      (c) => c.category === "imports" && c.pattern === "relative imports",
    );

    expect(namingConv).toBeDefined();
    expect(namingConv!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(importConv).toBeDefined();
  });

  test("error_handling detector still fires after the extension", async () => {
    const tryCatchContent = (n: number) =>
      `export async function load${n}() {\n` +
      `  try {\n` +
      `    return await fetch('/api');\n` +
      `  } catch (e) {\n` +
      `    throw new Error(String(e));\n` +
      `  }\n` +
      `}\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`loader${i}.ts`, tryCatchContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const errConv = conventions.find(
      (c) =>
        c.category === "error_handling" &&
        c.pattern === "try/catch error handling",
    );
    expect(errConv).toBeDefined();
  });

  test("testing detector still fires for files in a tests sub-directory", async () => {
    const testsDir = join(tempDir, "tests");
    await mkdir(testsDir, { recursive: true });

    const testContent = (n: number) =>
      `import { test, expect } from 'bun:test';\n` +
      `test('case ${n}', () => { expect(${n}).toBe(${n}); });\n`;

    for (let i = 1; i <= 6; i++) {
      await writeFile(
        join(testsDir, `spec${i}.test.ts`),
        testContent(i),
        "utf-8",
      );
    }

    const conventions = await detectConventions(tempDir);

    const testConv = conventions.find(
      (c) => c.category === "testing" && c.pattern === "bun test style",
    );
    expect(testConv).toBeDefined();
  });
});
