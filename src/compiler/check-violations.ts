/**
 * Convention violation engine for Gyst.
 *
 * Given a file path (and optional pre-loaded content), fetches all active
 * convention entries from the database that apply to the file's directory,
 * then dispatches per-category checkers to produce a sorted list of
 * Violation objects.
 *
 * Architecture note: this module is intentionally pure — it reads from the DB
 * and from disk but never writes. The MCP check tool owns the I/O boundary.
 */

import { readFileSync } from "fs";
import { basename, dirname, relative } from "path";
import type { Database } from "bun:sqlite";
import {
  FILE_NAMING,
  IMPORT_LINE,
  FN_DECL_NAMED,
  ERR_THROW_BARE,
  classifyImportSource,
  caseOf,
} from "./patterns.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Violation {
  readonly line: number;     // 1-based; 0 if not line-specific
  readonly column: number;   // 0-based; 0 if not column-specific
  readonly severity: "error" | "warning" | "info";
  readonly rule: string;     // convention entry title
  readonly ruleId: string;   // convention entry id
  readonly message: string;
  readonly suggestion?: string;
}

// ---------------------------------------------------------------------------
// Internal row type returned by the DB query
// ---------------------------------------------------------------------------

interface ConvRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly tags: string;
}

// ---------------------------------------------------------------------------
// Severity ordering (lower index = higher priority in sort)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Violation["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ---------------------------------------------------------------------------
// DB helper: fetch conventions applicable to a given file path
// ---------------------------------------------------------------------------

/**
 * Returns all active convention entries whose scope covers the directory
 * containing `filePath`.  We strip any absolute prefix to get a repo-relative
 * directory prefix for LIKE matching (e.g. "src/mcp/tools").
 */
function fetchApplicableConventions(
  db: Database,
  filePath: string,
): ConvRow[] {
  // Build a repo-relative directory prefix from the absolute path.
  // entry_files.file_path is stored as "src/api/" (relative + trailing slash).
  const absDir = dirname(filePath);

  // Try to strip the process cwd to get a relative path; fall back to the
  // raw dirname if the file is outside cwd.
  let dirPrefix: string;
  try {
    dirPrefix = relative(process.cwd(), absDir);
  } catch {
    dirPrefix = absDir;
  }

  const likeParam = `${dirPrefix}%`;

  return db
    .query<ConvRow, [string]>(
      `SELECT DISTINCT e.id, e.title, e.content, e.confidence,
              GROUP_CONCAT(et.tag, ',') AS tags
       FROM entries e
       JOIN entry_tags et ON et.entry_id = e.id
       LEFT JOIN entry_files ef ON ef.entry_id = e.id
       WHERE e.type = 'convention' AND e.status = 'active'
         AND (
           ef.file_path LIKE ? OR ef.file_path IS NULL
           OR e.scope IN ('team', 'project')
         )
       GROUP BY e.id`,
    )
    .all(likeParam);
}

// ---------------------------------------------------------------------------
// Line-number helper
// ---------------------------------------------------------------------------

/**
 * Approximates the 1-based line number of `matchIndex` within `content` by
 * counting newlines before that offset.
 */
function lineAt(content: string, matchIndex: number): number {
  let count = 1;
  for (let i = 0; i < matchIndex; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Category checkers (all private)
// ---------------------------------------------------------------------------

/**
 * Checks function naming: if the convention title contains "camelCase",
 * any named function declaration whose name is not camelCase earns a warning.
 */
function checkNaming(
  content: string,
  _filePath: string,
  conv: ConvRow,
): Violation[] {
  const violations: Violation[] = [];

  if (!conv.title.toLowerCase().includes("camelcase")) {
    return violations;
  }

  // Create a fresh regex instance to avoid shared lastIndex state.
  const re = new RegExp(FN_DECL_NAMED.source, FN_DECL_NAMED.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (name !== undefined && caseOf(name) !== "camel") {
      violations.push({
        line: 0,
        column: 0,
        severity: "warning",
        rule: conv.title,
        ruleId: conv.id,
        message: `Function "${name}" does not follow camelCase naming convention.`,
        suggestion: `Rename to camelCase (e.g. "${name[0]!.toLowerCase()}${name.slice(1)}").`,
      });
    }
  }

  return violations;
}

/**
 * Checks file naming: emits an error if the file's basename does not match
 * the casing style stated in the convention title.
 */
function checkFileNaming(filePath: string, conv: ConvRow): Violation[] {
  const name = basename(filePath);
  const titleLower = conv.title.toLowerCase();

  if (titleLower.includes("kebab-case") || titleLower.includes("kebab case")) {
    if (!FILE_NAMING.kebab.test(name)) {
      return [
        {
          line: 0,
          column: 0,
          severity: "error",
          rule: conv.title,
          ruleId: conv.id,
          message: `File "${name}" does not follow kebab-case naming convention.`,
          suggestion: "Rename file to kebab-case (e.g. my-module.ts).",
        },
      ];
    }
  } else if (
    titleLower.includes("pascalcase") ||
    titleLower.includes("pascal case")
  ) {
    if (!FILE_NAMING.pascal.test(name)) {
      return [
        {
          line: 0,
          column: 0,
          severity: "error",
          rule: conv.title,
          ruleId: conv.id,
          message: `File "${name}" does not follow PascalCase naming convention.`,
          suggestion: "Rename file to PascalCase (e.g. MyModule.ts).",
        },
      ];
    }
  } else if (
    titleLower.includes("camelcase") ||
    titleLower.includes("camel case")
  ) {
    if (!FILE_NAMING.camel.test(name)) {
      return [
        {
          line: 0,
          column: 0,
          severity: "error",
          rule: conv.title,
          ruleId: conv.id,
          message: `File "${name}" does not follow camelCase naming convention.`,
          suggestion: "Rename file to camelCase (e.g. myModule.ts).",
        },
      ];
    }
  }

  return [];
}

/**
 * Checks import ordering: builtin -> external -> internal.
 * Any import that breaks this sequence earns a warning.
 */
function checkImportsOrder(content: string, conv: ConvRow): Violation[] {
  const violations: Violation[] = [];

  // Create a fresh regex instance to avoid shared lastIndex state.
  const re = new RegExp(IMPORT_LINE.source, IMPORT_LINE.flags);

  type ImportKind = "builtin" | "external" | "internal";
  const ORDER: Record<ImportKind, number> = {
    builtin: 0,
    external: 1,
    internal: 2,
  };

  let prevKind: ImportKind | null = null;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    const specifier = match[1];
    if (specifier === undefined) continue;

    const kind = classifyImportSource(specifier);

    if (prevKind !== null && ORDER[kind] < ORDER[prevKind]) {
      const line = lineAt(content, match.index);
      violations.push({
        line,
        column: 0,
        severity: "warning",
        rule: conv.title,
        ruleId: conv.id,
        message: `Import "${specifier}" (${kind}) appears after a ${prevKind} import. Expected order: builtin -> external -> internal.`,
        suggestion:
          "Move builtin imports to the top, then external, then internal.",
      });
    }

    prevKind = kind;
  }

  return violations;
}

/**
 * Checks error handling style: if the convention title mentions "try/catch"
 * and the file uses .catch( but has no try {, emit an info-level notice.
 */
function checkErrorHandling(content: string, conv: ConvRow): Violation[] {
  if (!conv.title.toLowerCase().includes("try/catch")) {
    return [];
  }

  const hasCatch = content.includes(".catch(");
  const hasTry = /\btry\s*\{/.test(content);

  if (hasCatch && !hasTry) {
    return [
      {
        line: 0,
        column: 0,
        severity: "info",
        rule: conv.title,
        ruleId: conv.id,
        message:
          "File uses Promise .catch() chains but no try/catch blocks. Convention prefers async/await with try/catch.",
        suggestion: "Convert .catch() handlers to try/catch with await.",
      },
    ];
  }

  return [];
}

/**
 * Checks for bare throw new Error when the convention requires custom
 * error classes.  Emits one warning per occurrence.
 */
function checkCustomErrors(content: string, conv: ConvRow): Violation[] {
  const violations: Violation[] = [];

  if (!conv.title.toLowerCase().includes("custom error")) {
    return violations;
  }

  // Create a fresh regex instance to avoid shared lastIndex state.
  const re = new RegExp(ERR_THROW_BARE.source, ERR_THROW_BARE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    const line = lineAt(content, match.index);
    violations.push({
      line,
      column: 0,
      severity: "warning",
      rule: conv.title,
      ruleId: conv.id,
      message:
        "Bare `throw new Error(...)` found. Convention requires a custom error subclass.",
      suggestion:
        "Replace with a custom error class (e.g. `throw new ValidationError(...)`).",
    });
  }

  return violations;
}

/**
 * Checks export style: warns if the convention expects named exports but the
 * file has a default export, or emits info if the convention expects default
 * exports but named exports are found.
 */
function checkExports(content: string, conv: ConvRow): Violation[] {
  const titleLower = conv.title.toLowerCase();

  if (titleLower.includes("named export")) {
    const hasDefault = /\bexport\s+default\b/.test(content);
    if (hasDefault) {
      return [
        {
          line: 0,
          column: 0,
          severity: "warning",
          rule: conv.title,
          ruleId: conv.id,
          message:
            "File uses `export default` but convention prefers named exports.",
          suggestion: "Convert default export to a named export.",
        },
      ];
    }
  } else if (titleLower.includes("default export")) {
    const hasNamed = /\bexport\s+(const|function|class|let|var)\b/.test(
      content,
    );
    if (hasNamed) {
      return [
        {
          line: 0,
          column: 0,
          severity: "info",
          rule: conv.title,
          ruleId: conv.id,
          message:
            "File uses named exports but convention prefers a default export.",
          suggestion: "Consider converting to a default export.",
        },
      ];
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a single convention row to the appropriate checker(s) based on
 * its category tags, then returns any violations found.
 */
function dispatchConvention(
  content: string,
  filePath: string,
  conv: ConvRow,
): Violation[] {
  const tags = conv.tags ?? "";
  const collected: Violation[] = [];

  if (tags.includes("category:naming")) {
    collected.push(...checkNaming(content, filePath, conv));
  }
  if (tags.includes("category:file_naming")) {
    collected.push(...checkFileNaming(filePath, conv));
  }
  if (tags.includes("category:imports_order")) {
    collected.push(...checkImportsOrder(content, conv));
  }
  if (tags.includes("category:error_handling")) {
    collected.push(...checkErrorHandling(content, conv));
  }
  if (tags.includes("category:custom_errors")) {
    collected.push(...checkCustomErrors(content, conv));
  }
  if (tags.includes("category:exports")) {
    collected.push(...checkExports(content, conv));
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks a file against all active conventions stored in the database and
 * returns an immutable, sorted list of violations.
 *
 * Violations are sorted by severity (error -> warning -> info), then by line
 * number ascending within each severity bucket.
 *
 * @param db          - Open bun:sqlite database connection.
 * @param filePath    - Absolute (or cwd-relative) path to the file to check.
 * @param fileContent - Optional pre-loaded file content. When omitted the file
 *                      is read synchronously from disk.
 * @returns Readonly array of Violation objects, empty if none found.
 */
export function checkFileViolations(
  db: Database,
  filePath: string,
  fileContent?: string,
): readonly Violation[] {
  const content = fileContent ?? readFileSync(filePath, "utf-8");
  const conventions = fetchApplicableConventions(db, filePath);

  const all: Violation[] = [];
  for (const conv of conventions) {
    all.push(...dispatchConvention(content, filePath, conv));
  }

  // Sort: severity first, then line ascending.
  return Object.freeze(
    all.sort((a, b) => {
      const severityDiff =
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return a.line - b.line;
    }),
  );
}
