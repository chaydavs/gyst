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
