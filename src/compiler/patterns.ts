/**
 * Shared regex patterns and classifier utilities for the convention detector
 * and the (future) violation enforcer.
 *
 * Keeping patterns here avoids duplication and ensures both subsystems agree
 * on what constitutes a match.
 */

// ---------------------------------------------------------------------------
// File-naming patterns (match against the basename of the file)
// ---------------------------------------------------------------------------

export const FILE_NAMING = {
  kebab: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.(ts|tsx|js|jsx)$/,
  camel: /^[a-z][a-zA-Z0-9]*\.(ts|tsx|js|jsx)$/,
  pascal: /^[A-Z][a-zA-Z0-9]*\.(ts|tsx|js|jsx)$/,
} as const;

// ---------------------------------------------------------------------------
// Import patterns
// ---------------------------------------------------------------------------

/**
 * Matches a full import line; group 1 is the module specifier.
 * Used for ordering analysis and import classification.
 */
export const IMPORT_LINE =
  /^import\s+.+?\s+from\s+['"]([^'"]+)['"];?\s*$/gm;

// ---------------------------------------------------------------------------
// Function / class declaration patterns (for naming checks)
// ---------------------------------------------------------------------------

/** Named function declarations — group 1 is the function name. */
export const FN_DECL_NAMED = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** Class declarations — group 1 is the class name. */
export const CLASS_DECL = /\bclass\s+([A-Z][\w$]*)/g;

// ---------------------------------------------------------------------------
// Error-throw patterns
// ---------------------------------------------------------------------------

/** Bare `throw new Error(…)` — no custom subclass. */
export const ERR_THROW_BARE = /\bthrow\s+new\s+Error\s*\(/g;

/** Custom error class throws — group 1 is the class name (ends with "Error"). */
export const ERR_THROW_CUSTOM =
  /\bthrow\s+new\s+([A-Z][A-Za-z0-9]*Error)\s*\(/g;

// ---------------------------------------------------------------------------
// Classifier utilities
// ---------------------------------------------------------------------------

/**
 * Classify an import specifier as builtin (Node/Bun built-in), external
 * (npm package), or internal (relative path).
 *
 * Used by both the convention detector (ordering analysis) and the future
 * violation enforcer (lint-style checks).
 */
export function classifyImportSource(
  src: string,
): "builtin" | "external" | "internal" {
  if (src.startsWith(".") || src.startsWith("/")) return "internal";

  const builtins = new Set([
    "node:fs",
    "node:path",
    "node:os",
    "node:crypto",
    "node:stream",
    "node:http",
    "node:https",
    "node:url",
    "node:util",
    "node:buffer",
    "node:events",
    "node:child_process",
    "node:worker_threads",
    "fs",
    "path",
    "os",
    "crypto",
    "stream",
    "http",
    "https",
    "url",
    "util",
    "buffer",
    "events",
    "child_process",
    "worker_threads",
    "bun:sqlite",
    "bun:test",
  ]);

  if (
    builtins.has(src) ||
    src.startsWith("node:") ||
    src.startsWith("bun:")
  ) {
    return "builtin";
  }

  return "external";
}

/**
 * Returns the casing style of an identifier string.
 *
 * Examples:
 *   "myVar"        → "camel"
 *   "MyClass"      → "pascal"
 *   "my_var"       → "snake"
 *   "my-file"      → "kebab"
 *   "UPPER_CONST"  → "unknown"
 */
export function caseOf(
  name: string,
): "camel" | "pascal" | "snake" | "kebab" | "unknown" {
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)) return "kebab";
  if (
    /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$|^[a-z]+$/.test(name)
  )
    return "camel";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "pascal";
  if (/^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+$/.test(name)) return "snake";
  return "unknown";
}
