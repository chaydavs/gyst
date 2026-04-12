/**
 * Configuration loader for Gyst.
 *
 * Reads an optional `.gyst-wiki.json` file from `projectDir` (defaults to
 * `process.cwd()`).  Missing keys fall back to sensible defaults; the entire
 * file is optional.  Unknown keys are stripped by Zod.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "./logger.js";
import { ValidationError } from "./errors.js";

const CONFIG_FILE_NAME = ".gyst-wiki.json";

/** Zod schema that validates and provides defaults for the config file. */
const ConfigSchema = z.object({
  /** Directory where wiki markdown files are stored. */
  wikiDir: z.string().default("gyst-wiki"),
  /** Path to the SQLite database file. */
  dbPath: z.string().default("gyst-wiki/.wiki.db"),
  /** Maximum number of tokens to include in a recall response. */
  maxRecallTokens: z.number().int().positive().default(5000),
  /** Minimum confidence score for a result to be returned. */
  confidenceThreshold: z.number().min(0).max(1).default(0.15),
  /** Minimum log level emitted by the logger. */
  logLevel: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
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

  if (!existsSync(filePath)) {
    logger.debug("Config file not found, using defaults", { filePath });
    const result = ConfigSchema.safeParse({});
    if (!result.success) {
      // Should never happen since all fields have defaults, but be safe.
      throw new ValidationError(
        `Default config failed validation: ${result.error.message}`,
      );
    }
    return result.data;
  }

  let raw: unknown;
  try {
    const text = readFileSync(filePath, "utf-8");
    raw = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to parse config file at ${filePath}: ${msg}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      `Invalid config at ${filePath}: ${result.error.message}`,
    );
  }

  logger.debug("Config loaded", { filePath, config: result.data });
  return result.data;
}
