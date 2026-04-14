/**
 * Tests for detectConventions() — pure read-only analysis of source trees.
 *
 * Each test creates a temporary directory, writes synthetic TypeScript files
 * with predictable patterns, runs detectConventions(), and asserts on the
 * returned DetectedConvention array.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectConventions } from "../../src/compiler/detect-conventions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gyst-detect-conv-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write a file to `tempDir/<name>` with the given content. */
async function writeTs(name: string, content: string): Promise<void> {
  await writeFile(join(tempDir, name), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectConventions", () => {
  test("empty directory (< 5 files) returns []", async () => {
    // Only 3 files — below the MIN_FILES_PER_DIR=5 threshold
    await writeTs("a.ts", "export const x = 1;");
    await writeTs("b.ts", "export const y = 2;");
    await writeTs("c.ts", "export const z = 3;");

    const conventions = await detectConventions(tempDir);

    expect(conventions).toEqual([]);
  });

  test("camelCase naming detected when 6 files all use camelCase functions", async () => {
    const camelContent = (n: number) =>
      `export function getUserName${n}() { return ''; }\n` +
      `export const fetchData${n} = async () => {};\n` +
      `const handleRequest${n} = () => {};\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`file${i}.ts`, camelContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const namingConv = conventions.find(
      (c) => c.category === "naming" && c.pattern === "camelCase functions",
    );

    expect(namingConv).toBeDefined();
    expect(namingConv!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("relative imports detected when 6 files all use relative imports", async () => {
    const relContent = (n: number) =>
      `import { utils${n} } from './utils';\n` +
      `import { types${n} } from '../types';\n` +
      `export const fn${n} = () => {};\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`module${i}.ts`, relContent(i));
    }

    const conventions = await detectConventions(tempDir);

    const importConv = conventions.find(
      (c) => c.category === "imports" && c.pattern === "relative imports",
    );

    expect(importConv).toBeDefined();
  });

  test("skips node_modules — files inside it do not contribute", async () => {
    // Create 6 source files (camelCase) so the main dir passes the threshold
    const camelContent = (n: number) =>
      `export function getItem${n}() { return n${n}; }\n` +
      `export const fetchItem${n} = async () => {};\n`;

    for (let i = 1; i <= 6; i++) {
      await writeTs(`source${i}.ts`, camelContent(i));
    }

    // Put PascalCase files in node_modules — should be ignored
    const nmDir = join(tempDir, "node_modules", "some-lib");
    await mkdir(nmDir, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      await writeFile(
        join(nmDir, `Lib${i}.ts`),
        `export class LibClass${i} {}\nexport function LibFn${i}() {}\n`,
        "utf-8",
      );
    }

    const conventions = await detectConventions(tempDir);

    // The result should be based on the 6 camelCase source files, not the
    // node_modules PascalCase files.
    for (const conv of conventions) {
      expect(conv.pattern).not.toBe("PascalCase functions");
    }
  });

  test("confidence formula: 5 of 6 files match → confidence ≈ 0.83", async () => {
    // 5 camelCase files
    for (let i = 1; i <= 5; i++) {
      await writeTs(
        `camel${i}.ts`,
        `export function getUserData${i}() {}\n` +
          `export const fetchItems${i} = async () => {};\n`,
      );
    }
    // 1 PascalCase file (won't dominate because camel > pascal in aggregate)
    await writeTs(
      "pascal1.ts",
      `export function GetUser() {}\nexport class MyClass {}\n`,
    );

    const conventions = await detectConventions(tempDir);

    const namingConv = conventions.find(
      (c) => c.category === "naming" && c.pattern === "camelCase functions",
    );

    // 5/6 ≈ 0.833
    expect(namingConv).toBeDefined();
    expect(namingConv!.confidence).toBeCloseTo(5 / 6, 2);
    expect(namingConv!.evidence.filesScanned).toBe(6);
    expect(namingConv!.evidence.filesMatching).toBe(5);
  });
});
