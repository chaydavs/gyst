/**
 * Convention auto-detection for the Gyst compiler layer.
 *
 * Walks a source tree and analyses TypeScript/JavaScript files to infer
 * per-directory coding conventions (naming, imports, error handling, exports,
 * and testing style).  Results are pure data — no database writes are
 * performed here.
 */

import { readdir, readFile } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single convention detected within a directory. */
export interface DetectedConvention {
  category: "naming" | "imports" | "error_handling" | "exports" | "testing";
  /** Relative path like "src/api" */
  directory: string;
  /** Human-readable description: "camelCase functions", "relative imports", etc. */
  pattern: string;
  /** 0.0–1.0 based on filesMatching / filesScanned */
  confidence: number;
  evidence: {
    filesScanned: number;
    filesMatching: number;
    /** Up to 3 example file paths that match */
    examples: string[];
  };
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** camelCase: starts lowercase, has at least one uppercase letter */
const camelCaseFnRegex =
  /(?:function|const|let|var)\s+[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g;
/** PascalCase: starts uppercase */
const pascalCaseFnRegex = /(?:function|const|let|var)\s+[A-Z][a-zA-Z0-9]*/g;
/** snake_case: has underscores between words */
const snakeCaseFnRegex =
  /(?:function|const|let|var)\s+[a-z][a-z0-9]*_[a-z][a-zA-Z0-9_]*/g;
/** Relative import: starts with . or .. */
const relativeImportRegex = /from\s+['"][./]/g;
/** Absolute import: not relative (no leading dot) */
const absoluteImportRegex = /from\s+['"](?!\.)[^'"]+['"]/g;
/** try/catch block */
const tryCatchRegex = /\btry\s*\{/g;
/** promise .catch() chain */
const promiseCatchRegex = /\.catch\s*\(/g;
/** export default */
const defaultExportRegex = /^export\s+default\s+/gm;
/** named export */
const namedExportRegex =
  /^export\s+(?:function|const|class|let|var|type|interface)\s+/gm;
/** jest describe/it style */
const jestStyleRegex = /\b(?:describe|it)\s*\(/g;
/** bun test style */
const bunTestRegex = /\btest\s*\(/g;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const MIN_FILES_PER_DIR = 5;

/** Count all non-overlapping matches of a regex in a string. */
function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

/** Clamp a value to [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Per-file analysis result
// ---------------------------------------------------------------------------

interface FileAnalysis {
  path: string;
  camelCaseFns: number;
  pascalCaseFns: number;
  snakeCaseFns: number;
  relativeImports: number;
  absoluteImports: number;
  tryCatch: number;
  promiseCatch: number;
  defaultExports: number;
  namedExports: number;
  jestStyle: number;
  bunTest: number;
}

/**
 * Read and analyse a single source file.
 * Returns null if the file cannot be read (unreadable / binary / too large).
 */
async function analyseFile(filePath: string): Promise<FileAnalysis | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    logger.debug("detect-conventions: skipping unreadable file", {
      filePath,
      error: String(err),
    });
    return null;
  }

  return {
    path: filePath,
    camelCaseFns: countMatches(content, camelCaseFnRegex),
    pascalCaseFns: countMatches(content, pascalCaseFnRegex),
    snakeCaseFns: countMatches(content, snakeCaseFnRegex),
    relativeImports: countMatches(content, relativeImportRegex),
    absoluteImports: countMatches(content, absoluteImportRegex),
    tryCatch: countMatches(content, tryCatchRegex),
    promiseCatch: countMatches(content, promiseCatchRegex),
    defaultExports: countMatches(content, defaultExportRegex),
    namedExports: countMatches(content, namedExportRegex),
    jestStyle: countMatches(content, jestStyleRegex),
    bunTest: countMatches(content, bunTestRegex),
  };
}

// ---------------------------------------------------------------------------
// Directory-level convention detection
// ---------------------------------------------------------------------------

/**
 * Returns true when a directory path is a test directory or the files inside
 * are test files by naming convention.
 */
function isTestContext(dirPath: string, filePaths: string[]): boolean {
  const dirName = basename(dirPath);
  if (dirName === "tests" || dirName === "__tests__") return true;
  return filePaths.some((p) => /\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(p));
}

/**
 * Build a list of {@link DetectedConvention} objects for a single directory
 * given its analysed files and the root for computing relative paths.
 */
function detectForDirectory(
  analyses: FileAnalysis[],
  dirPath: string,
  rootDir: string,
): DetectedConvention[] {
  const conventions: DetectedConvention[] = [];
  const relDir = relative(rootDir, dirPath) || ".";
  const total = analyses.length;
  const THRESHOLD_70 = 0.7;
  const THRESHOLD_60 = 0.6;

  // Helper: build evidence for files whose predicate returns true.
  function buildEvidence(
    matchingPaths: string[],
  ): DetectedConvention["evidence"] {
    return {
      filesScanned: total,
      filesMatching: matchingPaths.length,
      examples: matchingPaths.slice(0, 3),
    };
  }

  // Helper: emit a convention when ratio >= threshold.
  function maybeEmit(
    category: DetectedConvention["category"],
    pattern: string,
    matchingPaths: string[],
    threshold: number,
  ): void {
    const ratio = matchingPaths.length / total;
    if (ratio >= threshold) {
      conventions.push({
        category,
        directory: relDir,
        pattern,
        confidence: clamp01(ratio),
        evidence: buildEvidence(matchingPaths),
      });
    }
  }

  // --- naming ---
  const namingCounts = analyses.map((a) => ({
    path: a.path,
    camel: a.camelCaseFns,
    pascal: a.pascalCaseFns,
    snake: a.snakeCaseFns,
  }));

  const camelFiles = namingCounts
    .filter((f) => f.camel > f.pascal && f.camel > f.snake && f.camel > 0)
    .map((f) => f.path);
  const pascalFiles = namingCounts
    .filter((f) => f.pascal > f.camel && f.pascal > f.snake && f.pascal > 0)
    .map((f) => f.path);
  const snakeFiles = namingCounts
    .filter((f) => f.snake > f.camel && f.snake > f.pascal && f.snake > 0)
    .map((f) => f.path);

  maybeEmit("naming", "camelCase functions", camelFiles, THRESHOLD_70);
  maybeEmit("naming", "PascalCase functions", pascalFiles, THRESHOLD_70);
  maybeEmit("naming", "snake_case functions", snakeFiles, THRESHOLD_70);

  // --- imports ---
  const relFiles = analyses
    .filter((a) => a.relativeImports > a.absoluteImports)
    .map((a) => a.path);
  const absFiles = analyses
    .filter((a) => a.absoluteImports > a.relativeImports)
    .map((a) => a.path);

  maybeEmit("imports", "relative imports", relFiles, THRESHOLD_70);
  maybeEmit("imports", "absolute imports", absFiles, THRESHOLD_70);

  // --- error_handling ---
  const tryCatchFiles = analyses
    .filter((a) => a.tryCatch > a.promiseCatch)
    .map((a) => a.path);
  const promiseFiles = analyses
    .filter((a) => a.promiseCatch > a.tryCatch)
    .map((a) => a.path);

  maybeEmit(
    "error_handling",
    "try/catch error handling",
    tryCatchFiles,
    THRESHOLD_60,
  );
  maybeEmit(
    "error_handling",
    "promise chain error handling",
    promiseFiles,
    THRESHOLD_60,
  );

  // --- exports ---
  const defaultFiles = analyses
    .filter((a) => a.defaultExports > a.namedExports)
    .map((a) => a.path);
  const namedFiles = analyses
    .filter((a) => a.namedExports > a.defaultExports)
    .map((a) => a.path);

  maybeEmit("exports", "default exports", defaultFiles, THRESHOLD_70);
  maybeEmit("exports", "named exports", namedFiles, THRESHOLD_70);

  // --- testing (only in test contexts) ---
  if (isTestContext(dirPath, analyses.map((a) => a.path))) {
    const bunFiles = analyses
      .filter((a) => a.bunTest > a.jestStyle)
      .map((a) => a.path);
    const jestFiles = analyses
      .filter((a) => a.jestStyle > a.bunTest)
      .map((a) => a.path);

    maybeEmit("testing", "bun test style", bunFiles, THRESHOLD_60);
    maybeEmit("testing", "jest describe/it style", jestFiles, THRESHOLD_60);
  }

  return conventions;
}

// ---------------------------------------------------------------------------
// Directory traversal
// ---------------------------------------------------------------------------

/**
 * Recursively collect all source files grouped by their immediate parent
 * directory.  Skips node_modules, dist, and .git.
 *
 * Returns a Map from absolute directory path → array of absolute file paths.
 */
async function collectFilesByDirectory(
  rootDir: string,
): Promise<Map<string, string[]>> {
  const byDir = new Map<string, string[]>();

  let allEntries: string[];
  try {
    allEntries = (await readdir(rootDir, { recursive: true })) as string[];
  } catch (err) {
    logger.warn("detect-conventions: cannot read root directory", {
      rootDir,
      error: String(err),
    });
    return byDir;
  }

  for (const entry of allEntries) {
    const absPath = join(rootDir, entry);
    const parts = entry.split(/[\\/]/);

    // Skip any path that passes through a blocked directory.
    if (parts.some((part) => SKIP_DIRS.has(part))) continue;

    const ext = extname(absPath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    // Group by immediate parent directory.
    const dirPath = join(rootDir, ...parts.slice(0, -1));
    const existing = byDir.get(dirPath);
    if (existing) {
      existing.push(absPath);
    } else {
      byDir.set(dirPath, [absPath]);
    }
  }

  return byDir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect coding conventions in `rootDir` by analysing TypeScript/JavaScript
 * source files.
 *
 * Only directories with at least 5 matching files are considered.  Results are
 * sorted by confidence descending so the most reliable signals appear first.
 *
 * This is a pure read-only operation — no database writes are performed.
 *
 * @param rootDir - Absolute path to the project root to scan.
 * @returns Array of detected conventions, sorted by confidence descending.
 */
export async function detectConventions(
  rootDir: string,
): Promise<DetectedConvention[]> {
  logger.info("detect-conventions: starting scan", { rootDir });

  const byDir = await collectFilesByDirectory(rootDir);

  const allConventions: DetectedConvention[] = [];

  for (const [dirPath, filePaths] of byDir) {
    if (filePaths.length < MIN_FILES_PER_DIR) {
      logger.debug("detect-conventions: skipping dir (too few files)", {
        dirPath,
        count: filePaths.length,
      });
      continue;
    }

    logger.debug("detect-conventions: analysing directory", {
      dirPath,
      files: filePaths.length,
    });

    // Analyse all files in this directory concurrently.
    const analysisResults = await Promise.all(filePaths.map(analyseFile));
    const analyses = analysisResults.filter(
      (a): a is FileAnalysis => a !== null,
    );

    if (analyses.length < MIN_FILES_PER_DIR) continue;

    const dirConventions = detectForDirectory(analyses, dirPath, rootDir);
    allConventions.push(...dirConventions);
  }

  const sorted = [...allConventions].sort((a, b) => b.confidence - a.confidence);

  logger.info("detect-conventions: scan complete", {
    rootDir,
    directoriesScanned: byDir.size,
    conventionsFound: sorted.length,
  });

  return sorted;
}
