/**
 * Configuration loader for Gyst.
 *
 * Reads an optional `.gyst-wiki.json` file from the project root and returns
 * fully-resolved paths. Project root is located by walking upward from the
 * start directory looking for a `.gyst/` folder — the same strategy git uses
 * to find `.git/`. A user who runs `gyst add` from a subfolder therefore acts
 * on the project's single knowledge base instead of silently creating a new
 * one in whatever directory they happened to be in.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { logger } from "./logger.js";
import { NoProjectError, ValidationError } from "./errors.js";

const CONFIG_FILE_NAME = ".gyst-wiki.json";
const PROJECT_MARKER = ".gyst";

/** Zod schema that validates and provides defaults for the config file. */
const ConfigSchema = z.object({
  /** Directory where wiki markdown files are stored. */
  wikiDir: z.string().default("gyst-wiki"),
  /** Path to the SQLite database file. */
  dbPath: z.string().default(".gyst/wiki.db"),
  /** Path to the global personal database. */
  globalDbPath: z.string().default(join(homedir(), ".gyst", "global.db")),
  /** Maximum number of tokens to include in a recall response. */
  maxRecallTokens: z.number().int().positive().default(5000),
  /** Minimum confidence score for a result to be returned. */
  confidenceThreshold: z.number().min(0).max(1).default(0.15),
  /** Minimum log level emitted by the logger. */
  logLevel: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
  /** When true, write markdown files after every learn. Default: false. */
  autoExport: z.boolean().default(false),
  /**
   * When true, the rule-based classifier is allowed to scope entries as
   * "team" based on team-signal phrases ("we use", "always", "never", …).
   * Default is false — entries stay personal until the user runs
   * `gyst team init`, which flips this flag. Prevents a single-dev project
   * from accidentally polluting a shared team layer that does not exist.
   */
  teamMode: z.boolean().default(false),
  /**
   * Where this project's knowledge lives. Set by the install-time
   * scope-selection prompt and switchable later via `gyst privacy`.
   *   - "local"         — wiki dir inside the project (default).
   *   - "private-repo"  — wiki dir points at a sibling private repo.
   *   - "http-server"   — agents talk to a shared HTTP server; no local wiki writes.
   */
  privacyMode: z.enum(["local", "private-repo", "http-server"]).default("local"),
  /** Base URL of the shared Gyst HTTP server (only used when privacyMode is "http-server"). */
  serverUrl: z.string().optional(),
});

/** Fully-resolved Gyst configuration. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Walks upward from `startDir` looking for a directory containing `.gyst/`.
 *
 * Returns the first ancestor directory that contains the marker, or `null`
 * if the filesystem root is reached without finding one. Mirrors git's
 * `.git/` discovery so running `gyst` from any subfolder acts on the one
 * knowledge base at the project root — not a new orphan database under cwd.
 *
 * @param startDir - Directory to start the walk from. Defaults to `process.cwd()`.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, PROJECT_MARKER))) return dir;
    const parent = dirname(dir);
    // dirname of a filesystem root returns itself on both POSIX and Windows.
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Recursively scans `root` for directories containing a `.gyst/` folder.
 *
 * Used by `gyst projects` to help users find orphan knowledge bases — the
 * common failure mode where a user accidentally ran `gyst add` from the
 * wrong directory and ended up with a second, hidden database.
 *
 * Skips common noise directories (`node_modules`, `.git`, build outputs)
 * and any dotfile directory other than `.gyst`. Descends past found
 * projects so nested orphans surface too.
 *
 * @param root - Directory to begin the scan from.
 * @param maxDepth - Maximum recursion depth. Defaults to 8.
 * @returns Sorted list of absolute paths to project roots.
 */
export function findAllProjects(root: string, maxDepth = 8): string[] {
  const IGNORED = new Set([
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
    ".venv",
    "venv",
    "target",
  ]);
  const found: string[] = [];
  const start = resolve(root);

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === PROJECT_MARKER) {
        found.push(current);
        continue;
      }
      if (IGNORED.has(entry.name)) continue;
      // Skip other dotfile dirs (e.g. .git) but still allow `.gyst` above.
      if (entry.name.startsWith(".")) continue;
      walk(join(current, entry.name), depth + 1);
    }
  }

  walk(start, 0);
  return found.sort();
}

/**
 * Loads and validates the `.gyst-wiki.json` configuration file.
 *
 * When `projectDir` is not provided, the project root is discovered via
 * `findProjectRoot()`. If no project root exists, `NoProjectError` is thrown
 * — the CLI catches this and prints a `gyst install` hint.
 *
 * All relative paths in the config (`dbPath`, `wikiDir`) are resolved to
 * absolute paths relative to the project root, so callers can safely open
 * the database or wiki dir from any cwd.
 *
 * @param projectDir - Explicit project root. When set, no upward walk occurs.
 * @returns The resolved, validated configuration with absolute paths.
 * @throws {NoProjectError} When no project root can be found.
 * @throws {ValidationError} When the config file is malformed.
 */
export function loadConfig(projectDir?: string): Config {
  let dir: string;
  if (projectDir) {
    dir = resolve(projectDir);
  } else {
    const root = findProjectRoot();
    if (root === null) throw new NoProjectError(process.cwd());
    dir = root;
  }

  const filePath = join(dir, CONFIG_FILE_NAME);
  const envDbPath = process.env["GYST_DB_PATH"];
  const envWikiDir = process.env["GYST_WIKI_DIR"];

  let raw: any = {};
  if (existsSync(filePath)) {
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Failed to parse config file at ${filePath}: ${msg}`);
    }
  } else {
    logger.debug("Config file not found, using defaults", { filePath });
  }

  // Environment variables take precedence over config file
  if (envDbPath) raw.dbPath = envDbPath;
  if (envWikiDir) raw.wikiDir = envWikiDir;

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      `Invalid config at ${filePath}: ${result.error.message}`,
    );
  }

  // Resolve relative paths to the project root so any caller can initDatabase
  // or read the wiki dir without worrying about cwd at call time.
  const cfg = result.data;
  if (!isAbsolute(cfg.dbPath)) cfg.dbPath = join(dir, cfg.dbPath);
  if (!isAbsolute(cfg.wikiDir)) cfg.wikiDir = join(dir, cfg.wikiDir);

  logger.debug("Config loaded", { filePath, projectRoot: dir, config: cfg });
  return cfg;
}
