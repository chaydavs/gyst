import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify, entryToMarkdown, writeEntry } from "../../src/compiler/writer.js";
import type { KnowledgeEntry } from "../../src/compiler/extract.js";
import { ValidationError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gyst-writer-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: "learning",
    title: "Use strict equality in JavaScript",
    content:
      "Always use === instead of == to avoid type coercion bugs in code.",
    files: [],
    tags: [],
    confidence: 0.8,
    sourceCount: 1,
    status: "active",
    createdAt: now,
    lastConfirmed: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("produces kebab-case from a normal title", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("lowercases the result", () => {
    expect(slugify("Use Strict Equality")).toBe("use-strict-equality");
  });

  test("replaces multiple spaces with a single hyphen", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });

  test("strips non-alphanumeric characters (except hyphens)", () => {
    expect(slugify("TypeScript: Best Practices!")).toBe(
      "typescript-best-practices",
    );
  });

  test("strips leading and trailing hyphens", () => {
    expect(slugify("  -hello-  ")).toBe("hello");
  });

  test("collapses consecutive hyphens into one", () => {
    expect(slugify("foo--bar")).toBe("foo-bar");
  });

  test("handles a title with only special characters", () => {
    expect(slugify("!@#$%")).toBe("");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  test("preserves existing hyphens", () => {
    expect(slugify("server-side rendering")).toBe("server-side-rendering");
  });

  test("handles numeric titles", () => {
    expect(slugify("Rule 42 Applies")).toBe("rule-42-applies");
  });
});

// ---------------------------------------------------------------------------
// entryToMarkdown
// ---------------------------------------------------------------------------

describe("entryToMarkdown", () => {
  test("includes YAML frontmatter delimiters", () => {
    const md = entryToMarkdown(makeEntry());
    expect(md).toContain("---");
  });

  test("includes type in frontmatter", () => {
    const md = entryToMarkdown(makeEntry({ type: "convention" }));
    expect(md).toContain("type: convention");
  });

  test("includes confidence in frontmatter", () => {
    const md = entryToMarkdown(makeEntry({ confidence: 0.75 }));
    expect(md).toContain("confidence: 0.75");
  });

  test("includes sources count in frontmatter", () => {
    const md = entryToMarkdown(makeEntry({ sourceCount: 5 }));
    expect(md).toContain("sources: 5");
  });

  test("includes last_confirmed in frontmatter", () => {
    const now = "2024-06-01T00:00:00.000Z";
    const md = entryToMarkdown(makeEntry({ lastConfirmed: now }));
    expect(md).toContain("last_confirmed:");
    expect(md).toContain(now);
  });

  test("includes affects list when files are provided", () => {
    const md = entryToMarkdown(
      makeEntry({ files: ["src/app.ts", "src/utils.ts"] }),
    );
    expect(md).toContain("affects:");
    expect(md).toContain("src/app.ts");
    expect(md).toContain("src/utils.ts");
  });

  test("omits affects when files is empty", () => {
    const md = entryToMarkdown(makeEntry({ files: [] }));
    expect(md).not.toContain("affects:");
  });

  test("includes tags list when tags are provided", () => {
    const md = entryToMarkdown(makeEntry({ tags: ["typescript", "testing"] }));
    expect(md).toContain("tags:");
    expect(md).toContain("typescript");
    expect(md).toContain("testing");
  });

  test("omits tags when tags is empty", () => {
    const md = entryToMarkdown(makeEntry({ tags: [] }));
    expect(md).not.toContain("tags:");
  });

  test("includes H1 title heading in body", () => {
    const md = entryToMarkdown(
      makeEntry({ title: "Use strict equality in JavaScript" }),
    );
    expect(md).toContain("# Use strict equality in JavaScript");
  });

  test("includes content in body", () => {
    const content =
      "Always use === instead of == to avoid type coercion bugs in code.";
    const md = entryToMarkdown(makeEntry({ content }));
    expect(md).toContain(content);
  });

  test("includes Fix section for error_pattern entries", () => {
    const md = entryToMarkdown(makeEntry({ type: "error_pattern" }));
    expect(md).toContain("## Fix");
  });

  test("does NOT include Fix section for non-error_pattern entries", () => {
    for (const type of ["convention", "decision", "learning"] as const) {
      const md = entryToMarkdown(makeEntry({ type }));
      expect(md).not.toContain("## Fix");
    }
  });

  test("includes Evidence section", () => {
    const md = entryToMarkdown(makeEntry());
    expect(md).toContain("## Evidence");
  });

  test("includes Sources count in Evidence section", () => {
    const md = entryToMarkdown(makeEntry({ sourceCount: 3 }));
    expect(md).toContain("**Sources:** 3");
  });

  test("lists affected files in Evidence section", () => {
    const md = entryToMarkdown(makeEntry({ files: ["src/index.ts"] }));
    expect(md).toContain("**Affected files:**");
    expect(md).toContain("`src/index.ts`");
  });
});

// ---------------------------------------------------------------------------
// writeEntry
// ---------------------------------------------------------------------------

describe("writeEntry", () => {
  test("creates a file in {wikiDir}/{type}/{slug}.md", () => {
    const entry = makeEntry({
      type: "learning",
      title: "Use strict equality always",
    });
    const filePath = writeEntry(entry, tmpDir);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain(join(tmpDir, "learning", "use-strict-equality-always.md"));
  });

  test("returns the absolute path to the written file", () => {
    const entry = makeEntry({
      type: "convention",
      title: "Prefer const over let",
    });
    const filePath = writeEntry(entry, tmpDir);
    expect(filePath).toStartWith(tmpDir);
    expect(filePath).toEndWith(".md");
  });

  test("written file contains valid YAML frontmatter", () => {
    const entry = makeEntry({ title: "Immutability is important always" });
    const filePath = writeEntry(entry, tmpDir);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("type:");
    expect(content).toContain("confidence:");
  });

  test("written file has correct type in frontmatter", () => {
    const entry = makeEntry({ type: "decision", title: "Record all decisions here" });
    const filePath = writeEntry(entry, tmpDir);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("type: decision");
  });

  test("written file has correct confidence in frontmatter", () => {
    const entry = makeEntry({ confidence: 0.9, title: "High confidence pattern found" });
    const filePath = writeEntry(entry, tmpDir);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("confidence: 0.9");
  });

  test("written file has sources in frontmatter", () => {
    const entry = makeEntry({ sourceCount: 4, title: "Well sourced knowledge entry" });
    const filePath = writeEntry(entry, tmpDir);
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("sources: 4");
  });

  test("creates parent directory if it does not exist", () => {
    const subDir = join(tmpDir, "nested", "wiki");
    const entry = makeEntry({ title: "Entry in nested directory here" });
    const filePath = writeEntry(entry, subDir);
    expect(existsSync(filePath)).toBe(true);
  });

  test("throws ValidationError for a title that produces empty slug", () => {
    const entry = makeEntry({ title: "!@#$%" });
    expect(() => writeEntry(entry, tmpDir)).toThrow(ValidationError);
  });

  test("handles error_pattern type with correct subdirectory", () => {
    const entry = makeEntry({
      type: "error_pattern",
      title: "Null pointer access error",
    });
    const filePath = writeEntry(entry, tmpDir);
    expect(filePath).toContain(join("error_pattern", "null-pointer-access-error.md"));
  });

  test("handles special characters in title gracefully", () => {
    const entry = makeEntry({
      title: "TypeScript: Best Practices for 2024",
    });
    const filePath = writeEntry(entry, tmpDir);
    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain("typescript-best-practices-for-");
  });

  test("file is UTF-8 encoded", () => {
    const entry = makeEntry({ title: "UTF-8 encoded content here" });
    const filePath = writeEntry(entry, tmpDir);
    // readFileSync with utf8 flag will throw if the file is not valid UTF-8
    expect(() => readFileSync(filePath, "utf8")).not.toThrow();
  });
});
