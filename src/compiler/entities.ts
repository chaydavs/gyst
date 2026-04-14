/**
 * Lightweight entity extraction for knowledge entries.
 *
 * Without tree-sitter (a V4 dependency), Gyst extracts code entities
 * (functions, classes, methods, constants) from entry content using
 * conservative regex patterns. The goal is to give the graph search
 * layer per-entity anchors so queries like "getToken function" can
 * find entries that mention getToken specifically, not just files.
 *
 * Design tradeoffs:
 *   - Regex-based: fast, works across languages, no AST dependency
 *   - Conservative: prefer false negatives over false positives
 *     (a missed entity is OK; a wrong entity pollutes the index)
 *   - Language-agnostic surface: one regex set covers TS, JS, Python,
 *     Go, Rust, Java, C/C++. Ignores language-specific details.
 */

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EntityKind = "function" | "class" | "method" | "constant";

export interface ExtractedEntity {
  readonly name: string;
  readonly kind: EntityKind;
}

// ---------------------------------------------------------------------------
// Filter sets
// ---------------------------------------------------------------------------

/**
 * Reserved words across major languages. Names matching any of these are
 * discarded as false positives regardless of which pattern captured them.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "return",
  "import",
  "export",
  "const",
  "let",
  "var",
  "type",
  "enum",
  "true",
  "false",
  "null",
  "void",
  "string",
  "number",
  "boolean",
  "this",
  "self",
  "new",
  "try",
  "catch",
  "throw",
  "break",
  "continue",
  "else",
  "then",
  "do",
  "as",
  "in",
  "of",
  "is",
  "or",
  "and",
  "not",
]);

/**
 * Common English verbs and words that survive the camelCase check but are
 * almost never actual code entities in prose descriptions.
 */
const COMMON_ENGLISH_WORDS: ReadonlySet<string> = new Set([
  "includes",
  "contains",
  "matches",
  "returns",
  "throws",
  "parses",
  "calls",
  "uses",
  "gets",
  "sets",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `name` passes all filter rules (allowed to be an entity).
 */
function isAllowed(name: string): boolean {
  // Rule 1: name must be at least 3 characters
  if (name.length < 3) {
    return false;
  }
  // Rule 2: not a reserved word in any major language
  if (RESERVED_WORDS.has(name)) {
    return false;
  }
  // Rule 3: not a common English word that slips through
  if (COMMON_ENGLISH_WORDS.has(name)) {
    return false;
  }
  return true;
}

/**
 * Returns true if `name` contains at least one uppercase letter after a
 * lowercase letter — the minimal definition of camelCase used to filter
 * method candidates.
 */
function hasCamelCase(name: string): boolean {
  return /[a-z][A-Z]/.test(name);
}

/**
 * Deduplicates an array of entities by (name, kind) pair.
 * Preserves the order of first occurrence.
 */
function deduplicate(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.kind}:${entity.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entity);
    }
  }
  return result;
}

/**
 * Runs all extraction patterns against `text` and returns raw (pre-dedup)
 * entity candidates. Patterns are applied most-specific first.
 */
function runPatterns(text: string): ExtractedEntity[] {
  const candidates: ExtractedEntity[] = [];

  // ------------------------------------------------------------------
  // Pattern 1a: TypeScript/JavaScript function declarations with parens
  //    Matches: function name(  OR  export function name(
  // ------------------------------------------------------------------
  const tsFunctionDeclPattern =
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m: RegExpExecArray | null;

  tsFunctionDeclPattern.lastIndex = 0;
  while ((m = tsFunctionDeclPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 1b: Natural language "function" reference without parens
  //    Matches: "function NAME" when NAME is not followed by ( (prose)
  //    and: "NAME function" (natural language descriptions like
  //    "the searchByBM25 function crashes")
  //
  //    Applied only to camelCase names to stay conservative.
  // ------------------------------------------------------------------
  // "function NAME" without opening paren (prose description)
  const proseFunctionKwPattern =
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)(?!\s*\()/g;

  proseFunctionKwPattern.lastIndex = 0;
  while ((m = proseFunctionKwPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name) && hasCamelCase(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // "NAME function" — camelCase name immediately followed by the word "function"
  const proseNameFunctionPattern =
    /\b([a-z][A-Za-z0-9_$]{2,})\s+function\b/g;

  proseNameFunctionPattern.lastIndex = 0;
  while ((m = proseNameFunctionPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name) && hasCamelCase(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 2: TypeScript/JavaScript const arrow functions
  //    Matches: const name = (  or  const name = async (
  // ------------------------------------------------------------------
  const tsArrowPattern =
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/g;

  tsArrowPattern.lastIndex = 0;
  while ((m = tsArrowPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 3: Classes (must start uppercase — PascalCase convention)
  // ------------------------------------------------------------------
  const classPattern = /\bclass\s+([A-Z][A-Za-z0-9_$]*)/g;

  classPattern.lastIndex = 0;
  while ((m = classPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "class" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 4: Go: func name
  // ------------------------------------------------------------------
  const goFuncPattern = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  goFuncPattern.lastIndex = 0;
  while ((m = goFuncPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 5: Rust: fn name
  // ------------------------------------------------------------------
  const rustFnPattern = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  rustFnPattern.lastIndex = 0;
  while ((m = rustFnPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 6: Python/Ruby: def method_name
  // ------------------------------------------------------------------
  const pyDefPattern = /\bdef\s+([a-z_][a-z0-9_]*)/g;

  pyDefPattern.lastIndex = 0;
  while ((m = pyDefPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name)) {
      candidates.push({ name, kind: "function" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 7: Method calls — camelCase name followed by (
  //    Very conservative: must start lowercase, length >= 3, must contain
  //    at least one camelCase transition (lowercase followed by uppercase).
  //    Applied before bare-word pattern so call sites are classified as
  //    method, not just bare entity.
  // ------------------------------------------------------------------
  const methodPattern = /\b([a-z][A-Za-z0-9_$]{2,})\s*\(/g;

  methodPattern.lastIndex = 0;
  while ((m = methodPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name) && hasCamelCase(name)) {
      candidates.push({ name, kind: "method" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 8: Bare camelCase identifiers (no keyword, no parens)
  //    Captures names like "searchByBM25" in titles and prose when they
  //    appear as standalone words (e.g. "searchByBM25 throws on empty FTS").
  //    Requires camelCase (lowercase→uppercase transition) to stay
  //    conservative. Produces "method" kind as the closest approximation
  //    for an unqualified camelCase name in prose.
  //    Applied last — previous patterns already claimed calls and declarations.
  // ------------------------------------------------------------------
  const bareCamelPattern = /\b([a-z][A-Za-z0-9_$]{2,})\b/g;

  bareCamelPattern.lastIndex = 0;
  while ((m = bareCamelPattern.exec(text)) !== null) {
    const name = m[1];
    if (isAllowed(name) && hasCamelCase(name)) {
      candidates.push({ name, kind: "method" });
    }
  }

  // ------------------------------------------------------------------
  // Pattern 9: File paths
  //    Matches strings that look like relative or absolute paths with
  //    common source extensions (.ts, .js, .py, .go, .rs, .md).
  // ------------------------------------------------------------------
  const pathPattern = /\b([\w\-/.]+\.(?:ts|js|tsx|jsx|py|go|rs|md|json|yml|yaml))\b/g;

  pathPattern.lastIndex = 0;
  while ((m = pathPattern.exec(text)) !== null) {
    const name = m[1];
    // File paths don't need isAllowed/hasCamelCase checks — the extension
    // is a strong enough signal.
    candidates.push({ name, kind: "constant" }); // Classifying as constant for now as kind is restricted
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts code entities from free-text entry content.
 *
 * Processes the text with a sequence of regex patterns, deduplicates
 * results (case-sensitive), and filters out common false positives
 * (language keywords, short names, numeric suffixes).
 *
 * @param content - Free-text content from a knowledge entry.
 * @returns Array of unique entities found, or empty array if none.
 */
export function extractEntities(content: string): ExtractedEntity[] {
  if (content.trim().length === 0) {
    return [];
  }

  const candidates = runPatterns(content);
  const entities = deduplicate(candidates);

  logger.debug("Entities extracted from content", {
    entityCount: entities.length,
    contentLength: content.length,
  });

  return entities;
}

/**
 * Extracts entities specifically from an entry title.
 *
 * Titles are terse and more likely to contain entity names in their
 * "canonical" form (e.g. "searchByBM25 throws on empty FTS input").
 *
 * @param title - Entry title string.
 * @returns Array of unique entities.
 */
export function extractEntitiesFromTitle(title: string): ExtractedEntity[] {
  if (title.trim().length === 0) {
    return [];
  }

  const candidates = runPatterns(title);
  const entities = deduplicate(candidates);

  logger.debug("Entities extracted from title", {
    entityCount: entities.length,
    title,
  });

  return entities;
}
