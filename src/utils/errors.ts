/**
 * Custom error types for the Gyst project.
 * All errors carry a machine-readable `code` for structured error handling.
 */

/**
 * Base error class for all Gyst-specific errors.
 */
export class GystError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GystError";
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when input data fails schema or business-rule validation.
 */
export class ValidationError extends GystError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/**
 * Thrown when a SQLite or storage operation fails.
 */
export class DatabaseError extends GystError {
  constructor(message: string) {
    super(message, "DATABASE_ERROR");
    this.name = "DatabaseError";
  }
}

/**
 * Thrown when a full-text or graph search operation fails.
 */
export class SearchError extends GystError {
  constructor(message: string) {
    super(message, "SEARCH_ERROR");
    this.name = "SearchError";
  }
}

/**
 * Thrown when a security constraint is violated (e.g. path traversal attempt).
 */
export class SecurityError extends GystError {
  constructor(message: string) {
    super(message, "SECURITY_ERROR");
    this.name = "SecurityError";
  }
}

/**
 * Thrown when a Gyst CLI command is run outside any initialised project —
 * i.e. no `.gyst/` directory exists in the current directory or any parent.
 * The CLI catches this and prints a "run `gyst install`" hint.
 */
export class NoProjectError extends GystError {
  public readonly startDir: string;
  constructor(startDir: string) {
    super(
      `no Gyst project found in '${startDir}' or any parent directory.\n` +
        `  Run 'gyst install' here to initialise one, or cd into a directory that already has .gyst/.`,
      "NO_PROJECT",
    );
    this.name = "NoProjectError";
    this.startDir = startDir;
  }
}
