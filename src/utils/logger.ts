/**
 * Structured JSON logger for Gyst.
 *
 * All output goes to stderr so the MCP stdio transport on stdout is never
 * polluted with log lines. Each entry is a single JSON line containing:
 *   - timestamp: ISO-8601 string
 *   - level: "debug" | "info" | "warn" | "error"
 *   - message: human-readable string
 *   - context: optional arbitrary object with extra metadata
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

/**
 * Resolve the startup log level.
 *
 * Precedence (first match wins):
 *   1. GYST_LOG_LEVEL env var ("debug" | "info" | "warn" | "error")
 *   2. GYST_DEBUG=1 → "debug"
 *   3. --verbose flag in argv → "info"
 *   4. CLI invocation (argv[0] ends with "cli") → "warn" (keeps UX quiet)
 *   5. Default → "info"
 */
function resolveInitialLevel(): LogLevel {
  const envLevel = process.env["GYST_LOG_LEVEL"];
  if (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error") {
    return envLevel;
  }
  if (process.env["GYST_DEBUG"] === "1") return "debug";
  if (Array.isArray(process.argv) && process.argv.includes("--verbose")) return "info";

  const entry = process.argv[1] || "";
  const isCli = /cli(?:\.js|\.ts)?$/i.test(entry) || /\/gyst$/i.test(entry);
  return isCli ? "warn" : "info";
}

class Logger {
  private level: LogLevel = resolveInitialLevel();

  /**
   * Change the minimum log level at runtime.
   * Messages below this level are silently dropped.
   *
   * @param level - The new minimum level.
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Returns the current minimum log level.
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /** @internal */
  private write(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) {
      return;
    }
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(context !== undefined ? { context } : {}),
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  /**
   * Log a debug-level message (verbose, development only).
   *
   * @param message - Human-readable description.
   * @param context - Optional structured metadata.
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }

  /**
   * Log an informational message.
   *
   * @param message - Human-readable description.
   * @param context - Optional structured metadata.
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  /**
   * Log a warning — something unexpected but recoverable.
   *
   * @param message - Human-readable description.
   * @param context - Optional structured metadata.
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  /**
   * Log an error — something that requires attention.
   *
   * @param message - Human-readable description.
   * @param context - Optional structured metadata.
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }
}

/**
 * Singleton logger instance. Import and use throughout the codebase.
 * Call `logger.setLevel(...)` at startup if you need to change the level.
 */
export const logger = new Logger();

/**
 * Convenience re-export to allow `setLevel` calls at the module level.
 *
 * @param level - The new minimum log level.
 */
export function setLevel(level: LogLevel): void {
  logger.setLevel(level);
}
