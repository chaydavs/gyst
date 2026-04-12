/**
 * Security filter for the Gyst compiler layer.
 *
 * Strips sensitive data from all content before it enters the wiki.
 * This module runs on EVERY piece of content at ingestion time.
 */

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Sensitive data patterns
// ---------------------------------------------------------------------------

/**
 * Ordered list of regular expressions that match secrets and sensitive values.
 * Each pattern is paired with a human-readable label used in log messages.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "api_key_assignment",
    pattern:
      /(?:api[_-]?key|token|secret|password|passwd|auth)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
  },
  {
    label: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    label: "private_key_header",
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  },
  {
    label: "connection_string",
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,
  },
  {
    label: "jwt_token",
    pattern:
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    label: "high_entropy_string",
    pattern: /['"][A-Za-z0-9+/]{40,}['"]/g,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replaces all sensitive patterns in `content` with a redaction placeholder.
 *
 * Returns a **new string** — the original is never mutated.
 *
 * @param content - Raw text that may contain secrets.
 * @returns Sanitised copy of the input with secrets replaced by `[REDACTED]`.
 */
export function stripSensitiveData(content: string): string {
  let sanitised = content;
  let redactionCount = 0;

  for (const { label, pattern } of SENSITIVE_PATTERNS) {
    // Reset lastIndex so global regexes work correctly on repeated calls.
    pattern.lastIndex = 0;
    const before = sanitised;
    sanitised = sanitised.replace(pattern, "[REDACTED]");
    if (sanitised !== before) {
      redactionCount++;
      logger.warn("Sensitive data redacted", { pattern: label });
    }
    // Reset lastIndex again after replace in case the engine leaves it dirty.
    pattern.lastIndex = 0;
  }

  if (redactionCount > 0) {
    logger.info("Content sanitised", { patternsTriggered: redactionCount });
  }

  return sanitised;
}

/**
 * Returns `true` if `content` contains any data that matches a sensitive
 * pattern. The content is **not** modified.
 *
 * @param content - Text to inspect.
 * @returns `true` when at least one sensitive pattern is found.
 */
export function containsSensitiveData(content: string): boolean {
  for (const { pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    const found = pattern.test(content);
    pattern.lastIndex = 0;
    if (found) {
      return true;
    }
  }
  return false;
}
