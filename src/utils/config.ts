/**
 * Configuration loader for Gyst.
 *
 * Reads an optional `.gyst-wiki.json` file from `projectDir` (defaults to
 * `process.cwd()`).  Missing keys fall back to sensible defaults; the entire
 * file is optional.  Unknown keys are stripped by Zod.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { logger } from "./logger.js";
import { ValidationError } from "./errors.js";

const CONFIG_FILE_NAME = ".gyst-wiki.json";

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
   * When true, expose all extended MCP tools (graph, feedback, harvest,
   * status, configure). Default: false — only 3 primary tools are registered
   * (learn, recall, check). Toggle with `gyst configure --extended-tools`.
   */
  exposeExtendedTools: z.boolean().default(false),
});

/** Fully-resolved Gyst configuration. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates the `.gyst-wiki.json` configuration file.
 *
 * If the file does not exist the Zod defaults are used.
 * If the file exists but contains invalid JSON or fails validation a
 * `ValidationError` is thrown.
 *
 * @param projectDir - Directory to search for the config file.
 *   Defaults to `process.cwd()`.
 * @returns The resolved, validated configuration.
 * @throws {ValidationError} If the config file contains invalid data.
 */
export function loadConfig(projectDir?: string): Config {
  const dir = projectDir ?? process.cwd();
  const filePath = join(dir, CONFIG_FILE_NAME);

  const envDbPath = process.env["GYST_DB_PATH"];
  const envWikiDir = process.env["GYST_WIKI_DIR"];

  let defaults: any = {};
  if (envDbPath) defaults.dbPath = envDbPath;
  if (envWikiDir) defaults.wikiDir = envWikiDir;

  if (!existsSync(filePath)) {
    logger.debug("Config file not found, using defaults", { filePath });
    const result = ConfigSchema.safeParse(defaults);
    if (!result.success) {
      throw new ValidationError(
        `Default config failed validation: ${result.error.message}`,
      );
    }
    return result.data;
  }

  let raw: any;
  try {
    const text = readFileSync(filePath, "utf-8");
    raw = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to parse config file at ${filePath}: ${msg}`);
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

  logger.debug("Config loaded", { filePath, config: result.data });
  return result.data;
}
