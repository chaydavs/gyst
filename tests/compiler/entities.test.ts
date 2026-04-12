import { describe, test, expect } from "bun:test";
import {
  extractEntities,
  extractEntitiesFromTitle,
} from "../../src/compiler/entities.js";
import type { ExtractedEntity } from "../../src/compiler/entities.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(
  entities: ExtractedEntity[],
  name: string,
): ExtractedEntity | undefined {
  return entities.find((e) => e.name === name);
}

function findByNameAndKind(
  entities: ExtractedEntity[],
  name: string,
  kind: ExtractedEntity["kind"],
): ExtractedEntity | undefined {
  return entities.find((e) => e.name === name && e.kind === kind);
}

// ---------------------------------------------------------------------------
// extractEntities — happy path
// ---------------------------------------------------------------------------

describe("extractEntities", () => {
  describe("typescript/javascript function declarations", () => {
    test("extracts a named function declaration", () => {
      const result = extractEntities(
        "function getToken(userId: string): string { return ''; }",
      );
      const entity = findByName(result, "getToken");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });

    test("extracts an exported function declaration", () => {
      const result = extractEntities(
        "export function searchByBM25(query: string): Result[] { return []; }",
      );
      const entity = findByNameAndKind(result, "searchByBM25", "function");
      expect(entity).toBeDefined();
    });

    test("extracts a const arrow function", () => {
      const result = extractEntities(
        "const fetchUser = (id: string) => getUserById(id);",
      );
      const entity = findByName(result, "fetchUser");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });

    test("extracts a const async arrow function", () => {
      const result = extractEntities(
        "const handleRequest = async (req: Request) => { return res; };",
      );
      const entity = findByName(result, "handleRequest");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });
  });

  describe("class declarations", () => {
    test("extracts a class declaration (PascalCase)", () => {
      const result = extractEntities(
        "class GystError extends Error { constructor(msg: string) {} }",
      );
      const entity = findByName(result, "GystError");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("class");
    });

    test("does not produce a class entity for a lowercase-start name", () => {
      const result = extractEntities("class gystError {}");
      // gystError starts lowercase — not captured by class pattern
      const classEntities = result.filter((e) => e.kind === "class");
      expect(classEntities.find((e) => e.name === "gystError")).toBeUndefined();
    });
  });

  describe("python/ruby-style definitions", () => {
    test("extracts a python def function", () => {
      const result = extractEntities("def handle_commit(repo): return files");
      const entity = findByName(result, "handle_commit");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });

    test("extracts multiple python def functions", () => {
      const result = extractEntities(
        "def parse_config(path): pass\ndef load_schema(name): pass",
      );
      expect(findByName(result, "parse_config")).toBeDefined();
      expect(findByName(result, "load_schema")).toBeDefined();
    });
  });

  describe("go functions", () => {
    test("extracts a go func declaration", () => {
      const result = extractEntities(
        "func handleWebhook(w http.ResponseWriter, r *http.Request) {}",
      );
      const entity = findByName(result, "handleWebhook");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });
  });

  describe("rust functions", () => {
    test("extracts a rust fn declaration", () => {
      const result = extractEntities(
        "fn parse_request(input: &str) -> Result<Request, Error> {}",
      );
      const entity = findByName(result, "parse_request");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });
  });

  describe("method calls with camelCase names", () => {
    test("extracts a camelCase method call from prose (NAME function pattern)", () => {
      const result = extractEntities(
        "The searchByBM25 function crashes when the query contains 'OR' between parenthesised groups.",
      );
      const entity = findByName(result, "searchByBM25");
      expect(entity).toBeDefined();
    });

    test("extracts a camelCase method call followed by parentheses", () => {
      const result = extractEntities(
        "Calling getUserById(id) always triggers a cache miss on cold start.",
      );
      const entity = findByName(result, "getUserById");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("method");
    });

    test("does not extract non-camelCase words as methods", () => {
      const result = extractEntities(
        "something should work fine without camel case transitions here.",
      );
      // "something" has no camelCase transition — should not appear as method
      const entity = findByName(result, "something");
      expect(entity).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe("deduplication", () => {
    test("same (name, kind) mentioned twice returns one entity", () => {
      const result = extractEntities(
        "The fetchData function is called. fetchData is the primary data loader.",
      );
      // "fetchData function" fires as function kind once
      const functionMatches = result.filter(
        (e) => e.name === "fetchData" && e.kind === "function",
      );
      expect(functionMatches.length).toBe(1);
    });

    test("same name in different kinds returns one entry per (name, kind) pair", () => {
      // "fetchData" declared as a function AND referenced as a method call
      const result = extractEntities(
        "function fetchData() {} then fetchData() is called.",
      );
      const functionMatches = result.filter(
        (e) => e.name === "fetchData" && e.kind === "function",
      );
      const methodMatches = result.filter(
        (e) => e.name === "fetchData" && e.kind === "method",
      );
      // function declaration pattern fires as "function"
      // method call pattern fires as "method"
      // each (name, kind) pair is unique in the output
      expect(functionMatches.length).toBe(1);
      expect(methodMatches.length).toBe(1);
    });

    test("two identical python def declarations produce one entity", () => {
      const result = extractEntities(
        "def handle_commit(repo): pass\ndef handle_commit(files): pass",
      );
      const matches = result.filter((e) => e.name === "handle_commit");
      expect(matches.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // False-positive suppression
  // -------------------------------------------------------------------------

  describe("false-positive suppression", () => {
    test("reserved word 'return' is filtered", () => {
      const result = extractEntities(
        "Use the return keyword to exit a function early.",
      );
      expect(findByName(result, "return")).toBeUndefined();
    });

    test("reserved word 'if' is filtered", () => {
      const result = extractEntities("if(condition) { doSomething(); }");
      expect(findByName(result, "if")).toBeUndefined();
    });

    test("reserved word 'for' is filtered", () => {
      const result = extractEntities("for(let i = 0; i < 10; i++) {}");
      expect(findByName(result, "for")).toBeUndefined();
    });

    test("single-character names are filtered", () => {
      const result = extractEntities("function f() {} and function g() {}");
      expect(findByName(result, "f")).toBeUndefined();
      expect(findByName(result, "g")).toBeUndefined();
    });

    test("two-character name 'fn' is filtered", () => {
      const result = extractEntities("fn foo() {} bar fn baz() {}");
      expect(findByName(result, "fn")).toBeUndefined();
    });

    test("common english verb 'includes' is filtered", () => {
      const result = extractEntities("The list includes() all items.");
      expect(findByName(result, "includes")).toBeUndefined();
    });

    test("common english verb 'returns' is filtered from prose", () => {
      const result = extractEntities("The returns(value) pattern is common.");
      expect(findByName(result, "returns")).toBeUndefined();
    });

    test("non-camelCase lowercase word is not treated as method", () => {
      const result = extractEntities("something(arg) here is not a method.");
      expect(findByName(result, "something")).toBeUndefined();
    });

    test("no clear entities in plain English prose returns empty", () => {
      const result = extractEntities(
        "Use the new raw body middleware on webhook routes",
      );
      // No code entity patterns should fire
      const codeEntities = result.filter(
        (e) => e.kind === "function" || e.kind === "method",
      );
      expect(codeEntities.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty string returns empty array", () => {
      const result = extractEntities("");
      expect(result).toEqual([]);
    });

    test("only whitespace returns empty array", () => {
      const result = extractEntities("   \n\t  ");
      expect(result).toEqual([]);
    });

    test("content with no code returns empty array", () => {
      const result = extractEntities(
        "This is just a plain sentence with no code at all.",
      );
      const codeEntities = result.filter(
        (e) => e.kind === "function" || e.kind === "method",
      );
      expect(codeEntities.length).toBe(0);
    });

    test("unicode in content does not crash", () => {
      expect(() =>
        extractEntities(
          "함수 function handleInput(input: string) {} 日本語テスト",
        ),
      ).not.toThrow();
    });

    test("very long content completes in under 100ms", () => {
      const chunk =
        "function handleRequest(req: Request): Response { return fetchData(req.id); } ";
      const longContent = chunk
        .repeat(Math.ceil(10000 / chunk.length))
        .slice(0, 10000);
      const start = Date.now();
      extractEntities(longContent);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });

  // -------------------------------------------------------------------------
  // Specification examples
  // -------------------------------------------------------------------------

  describe("specification examples", () => {
    test("searchByBM25 in prose extracts entity", () => {
      const result = extractEntities(
        "The searchByBM25 function crashes when the query contains 'OR' between parenthesised groups.",
      );
      const entity = findByName(result, "searchByBM25");
      expect(entity).toBeDefined();
    });

    test("class GystError extracts class entity", () => {
      const result = extractEntities(
        "class GystError extends Error. constructor takes code string.",
      );
      const entity = findByName(result, "GystError");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("class");
    });

    test("def handle_commit extracts function entity", () => {
      const result = extractEntities(
        "def handle_commit returns list of changed files",
      );
      const entity = findByName(result, "handle_commit");
      expect(entity).toBeDefined();
      expect(entity?.kind).toBe("function");
    });

    test("plain English about middleware produces no code entities", () => {
      const result = extractEntities(
        "Use the new raw body middleware on webhook routes",
      );
      const codeEntities = result.filter(
        (e) => e.kind === "function" || e.kind === "method",
      );
      expect(codeEntities.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesFromTitle
// ---------------------------------------------------------------------------

describe("extractEntitiesFromTitle", () => {
  test("extracts searchByBM25 from a title using NAME function pattern", () => {
    const result = extractEntitiesFromTitle(
      "searchByBM25 throws on empty FTS input",
    );
    // searchByBM25 is a standalone camelCase word in the title
    // It doesn't match "NAME function" here but it's camelCase
    // The spec expects it to be found; it will match via method pattern
    // if followed by (, or via name+function prose pattern
    // For a bare title word, we check if it was extracted
    const entity = findByName(result, "searchByBM25");
    expect(entity).toBeDefined();
  });

  test("plain English title returns no code entities", () => {
    const result = extractEntitiesFromTitle(
      "How to handle Stripe webhooks",
    );
    const codeEntities = result.filter(
      (e) => e.kind === "function" || e.kind === "method",
    );
    expect(codeEntities.length).toBe(0);
  });

  test("empty title returns empty array", () => {
    const result = extractEntitiesFromTitle("");
    expect(result).toEqual([]);
  });

  test("title with 'function NAME' extracts function", () => {
    const result = extractEntitiesFromTitle(
      "function parseConfig crashes on missing keys",
    );
    const entity = findByName(result, "parseConfig");
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe("function");
  });

  test("title with class declaration extracts class", () => {
    const result = extractEntitiesFromTitle(
      "class DatabasePool exhausts connections under load",
    );
    const entity = findByName(result, "DatabasePool");
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe("class");
  });
});
