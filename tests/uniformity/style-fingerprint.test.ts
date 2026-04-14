/**
 * Tests for fingerprintFile and fingerprintDirectory in
 * src/compiler/style-fingerprint.ts.
 *
 * All directory tests use a real temporary directory created with
 * mkdtempSync so they exercise the actual filesystem code path.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintFile,
  fingerprintDirectory,
  type StyleFingerprint,
} from "../../src/compiler/style-fingerprint.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a temporary directory and returns its path.
 * Registered via `afterEach` for cleanup.
 */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gyst-fp-test-"));
}

/**
 * Writes a `.ts` file into `dir` with the given content.
 */
function writeTs(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// Track temp dirs for cleanup.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// fingerprintFile — indent
// ---------------------------------------------------------------------------

describe("fingerprintFile — indent", () => {
  test("1. tabs-only file → indent: tabs", () => {
    const content = [
      "function foo() {",
      "\tconst x = 1;",
      "\tif (x) {",
      "\t\treturn x;",
      "\t}",
      "}",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.indent).toBe("tabs");
  });

  test("2. 2-space indented file → indent: spaces-2", () => {
    const content = [
      "function foo() {",
      "  const x = 1;",
      "  if (x) {",
      "    return x;",
      "  }",
      "}",
      "function bar() {",
      "  const y = 2;",
      "  return y;",
      "}",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.indent).toBe("spaces-2");
  });

  test("3. 4-space indented file → indent: spaces-4", () => {
    const content = [
      "function foo() {",
      "    const x = 1;",
      "    if (x) {",
      "        return x;",
      "    }",
      "}",
      "function bar() {",
      "    const y = 2;",
      "    return y;",
      "}",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.indent).toBe("spaces-4");
  });

  test("4. mixed indentation → indent: mixed", () => {
    // Roughly equal tabs and 2-space and 4-space — none achieves 70%.
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(`\tconst tab${i} = ${i};`);
    for (let i = 0; i < 5; i++) lines.push(`  const sp2${i} = ${i};`);
    for (let i = 0; i < 5; i++) lines.push(`    const sp4${i} = ${i};`);

    const fp = fingerprintFile(lines.join("\n"));
    expect(fp.indent).toBe("mixed");
  });
});

// ---------------------------------------------------------------------------
// fingerprintFile — semicolons
// ---------------------------------------------------------------------------

describe("fingerprintFile — semicolons", () => {
  test("5. all semicolons → semicolons: always", () => {
    const content = [
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "const f = 6;",
      "const g = 7;",
      "const h = 8;",
      "const i = 9;",
      "const j = 10;",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.semicolons).toBe("always");
  });

  test("6. no semicolons → semicolons: never", () => {
    const content = [
      "const a = 1",
      "const b = 2",
      "const c = 3",
      "const d = 4",
      "const e = 5",
      "const f = 6",
      "const g = 7",
      "const h = 8",
      "const i = 9",
      "const j = 10",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.semicolons).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// fingerprintFile — quotes
// ---------------------------------------------------------------------------

describe("fingerprintFile — quotes", () => {
  test("7. all single quotes → quotes: single", () => {
    const content = [
      "import { foo } from 'foo';",
      "import { bar } from 'bar';",
      "import { baz } from 'baz';",
      "const x = 'hello';",
      "const y = 'world';",
      "const z = 'test';",
      "const w = 'value';",
      "const v = 'another';",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.quotes).toBe("single");
  });

  test("8. all double quotes → quotes: double", () => {
    const content = [
      'import { foo } from "foo";',
      'import { bar } from "bar";',
      'import { baz } from "baz";',
      'const x = "hello";',
      'const y = "world";',
      'const z = "test";',
      'const w = "value";',
      'const v = "another";',
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.quotes).toBe("double");
  });
});

// ---------------------------------------------------------------------------
// fingerprintFile — trailingCommas
// ---------------------------------------------------------------------------

describe("fingerprintFile — trailingCommas", () => {
  test("9. trailing commas → trailingCommas: always", () => {
    // Use multiline function call / object patterns where `,` follows `}` or `]`
    // directly on the closing line — the canonical trailing-comma signal.
    const content = [
      "foo(",
      "  { a: 1, b: 2 },",
      "  { c: 3, d: 4 },",
      "  { e: 5, f: 6 },",
      ")",
      "bar([1, 2, 3],)",
      "const x = [",
      "  getValue(),",
      "],",
      "const y = [",
      "  getOther(),",
      "],",
      "const z = [",
      "  getLast(),",
      "],",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.trailingCommas).toBe("always");
  });

  test("10. no trailing commas → trailingCommas: never", () => {
    // Closing braces/brackets on their own line with no trailing comma.
    const content = [
      "const obj = {",
      "  a: 1,",
      "  b: 2",
      "}",
      "const arr = [",
      "  1,",
      "  2,",
      "  3",
      "]",
      "const obj2 = {",
      "  x: 'a',",
      "  y: 'b'",
      "}",
      "const obj3 = {",
      "  m: 1,",
      "  n: 2",
      "}",
    ].join("\n");

    const fp = fingerprintFile(content);
    expect(fp.trailingCommas).toBe("never");
  });
});

// ---------------------------------------------------------------------------
// fingerprintDirectory
// ---------------------------------------------------------------------------

describe("fingerprintDirectory", () => {
  test("11. directory with 3 consistent files → correct fingerprint", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    // All three files: tabs, always semicolons, single quotes, trailing commas.
    // Uses `],` and `},` (trailing comma on closing line) as trailing comma signal.
    // Seven `],` / `},` lines vs zero bare `}` / `]` → well over 70%.
    const fileContent = [
      "import { x } from 'x';",
      "import { y } from 'y';",
      "const arr1 = [",
      "\t'one',",
      "\t'two',",
      "],",
      "const arr2 = [",
      "\t'three',",
      "\t'four',",
      "],",
      "const arr3 = [",
      "\t'five',",
      "\t'six',",
      "],",
      "const arr4 = [",
      "\t'seven',",
      "\t'eight',",
      "],",
      "const arr5 = [",
      "\t'nine',",
      "\t'ten',",
      "],",
    ].join("\n");

    writeTs(dir, "a.ts", fileContent);
    writeTs(dir, "b.ts", fileContent);
    writeTs(dir, "c.ts", fileContent);

    const fp = fingerprintDirectory(dir);

    expect(fp.indent).toBe("tabs");
    expect(fp.semicolons).toBe("always");
    expect(fp.quotes).toBe("single");
    expect(fp.trailingCommas).toBe("always");
  });

  test("12. empty directory → all mixed", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const fp = fingerprintDirectory(dir);

    expect(fp.indent).toBe("mixed");
    expect(fp.semicolons).toBe("mixed");
    expect(fp.quotes).toBe("mixed");
    expect(fp.trailingCommas).toBe("mixed");
  });

  test("13. mixed-style files → mixed for contested dimensions", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    // File A: tabs + single quotes.
    const fileA = [
      "import { a } from 'a';",
      "import { b } from 'b';",
      "import { c } from 'c';",
      "function alpha() {",
      "\tconst x = 'val';",
      "\tconst y = 'val';",
      "\tconst z = 'val';",
      "\treturn x;",
      "}",
    ].join("\n");

    // File B: 4 spaces + double quotes, same number of signals.
    const fileB = [
      'import { d } from "d";',
      'import { e } from "e";',
      'import { f } from "f";',
      "function beta() {",
      '    const x = "val";',
      '    const y = "val";',
      '    const z = "val";',
      "    return x;",
      "}",
    ].join("\n");

    writeTs(dir, "a.ts", fileA);
    writeTs(dir, "b.ts", fileB);

    const fp = fingerprintDirectory(dir);

    // Neither tabs nor 4-space achieves 70% → mixed.
    expect(fp.indent).toBe("mixed");
    // Neither single nor double achieves 70% → mixed.
    expect(fp.quotes).toBe("mixed");
  });

  test("directory ignores node_modules and dist subdirectories", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    // Place consistent tabs files in the root.
    const tabContent = [
      "function foo() {",
      "\tconst a = 1;",
      "\tconst b = 2;",
      "\tconst c = 3;",
      "\tconst d = 4;",
      "\tconst e = 5;",
      "\treturn a;",
      "}",
    ].join("\n");

    writeTs(dir, "main.ts", tabContent);

    // Place a conflicting 4-space file in node_modules — should be ignored.
    const nmDir = join(dir, "node_modules");
    mkdirSync(nmDir);
    const spaceContent = [
      "function bar() {",
      "    const a = 1;",
      "    const b = 2;",
      "    const c = 3;",
      "    const d = 4;",
      "    const e = 5;",
      "    return a;",
      "}",
    ].join("\n");
    writeTs(nmDir, "vendor.ts", spaceContent);

    const fp = fingerprintDirectory(dir);
    // Only main.ts (tabs) should be counted.
    expect(fp.indent).toBe("tabs");
  });

  test("limit parameter caps the number of files sampled", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    // Write 10 files all with tabs indent.
    for (let i = 0; i < 10; i++) {
      writeTs(
        dir,
        `file${i}.ts`,
        [
          "function f() {",
          "\tconst x = 1;",
          "\treturn x;",
          "}",
        ].join("\n"),
      );
    }

    // limit=3 still works correctly — tabs should still win.
    const fp = fingerprintDirectory(dir, 3);
    expect(fp.indent).toBe("tabs");
  });
});
