/**
 * Error signature normalisation for the Gyst compiler layer.
 *
 * Transforms raw error messages into stable, environment-agnostic signatures
 * so that the same underlying error produces the same fingerprint regardless
 * of the machine, timestamp, or UUID it originated on.
 *
 * Normalisation steps are applied in order (most specific first) to avoid
 * over-replacing partial matches.
 */

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Normalisation rules (order-sensitive)
// ---------------------------------------------------------------------------

/**
 * Each rule replaces a class of volatile tokens with a stable placeholder.
 * Rules are applied in the order they appear here; more-specific patterns
 * must precede more-general ones.
 */
const NORMALISATION_RULES: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  replacement: string;
}> = [
  // 1. Memory addresses — must come before generic numbers
  {
    label: "memory_address",
    pattern: /0x[0-9a-fA-F]+/g,
    replacement: "<ADDR>",
  },
  // 2. UUIDs — must come before generic numbers
  {
    label: "uuid",
    pattern:
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: "<UUID>",
  },
  // 3. ISO-8601 timestamps — must come before file paths / numbers
  {
    label: "iso_timestamp",
    pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g,
    replacement: "<TS>",
  },
  // 4. URLs
  {
    label: "url",
    pattern: /https?:\/\/[^\s"']+/g,
    replacement: "<URL>",
  },
  // 5. File paths with extensions — e.g. /foo/bar.ts or ./baz/qux.js:12
  {
    label: "file_path",
    pattern: /(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,6}/g,
    replacement: "<PATH>",
  },
  // 6. Line:column references — e.g. :42 or :42:7
  {
    label: "line_col",
    pattern: /:\d+(?::\d+)?/g,
    replacement: ":<LINE>",
  },
  // 7. Quoted strings (single or double)
  {
    label: "quoted_string",
    pattern: /(?:"[^"]*"|'[^']*')/g,
    replacement: "<STR>",
  },
  // 8. Numbers — LAST numeric rule; replaces digit sequences
  //    Uses \d+ without word boundaries to catch numbers attached to
  //    suffixes like "30000ms", "5000s", etc.
  {
    label: "number",
    pattern: /\d+/g,
    replacement: "<N>",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces a normalised, lowercase version of an error message suitable for
 * deduplication and fingerprinting.
 *
 * @param message - The raw error message string.
 * @returns A normalised string with volatile tokens replaced by placeholders.
 */
export function normalizeErrorSignature(message: string): string {
  let normalised = message;

  for (const { label, pattern, replacement } of NORMALISATION_RULES) {
    pattern.lastIndex = 0;
    normalised = normalised.replace(pattern, replacement);
    pattern.lastIndex = 0;
    logger.debug("Normalisation rule applied", { label });
  }

  return normalised.toLowerCase();
}

/**
 * Generates a short, stable fingerprint for an error occurrence.
 *
 * The fingerprint is the first 16 hex characters of a SHA-256 digest over
 * the concatenation of `errorType`, the `normalizedMessage`, and — when
 * provided — the source location derived from `topFrame`.
 *
 * @param errorType - The error class name or category (e.g. `"TypeError"`).
 * @param normalizedMessage - Output of {@link normalizeErrorSignature}.
 * @param topFrame - Optional top stack frame used to anchor the fingerprint
 *   to a specific code location.
 * @returns 16-character hexadecimal fingerprint string.
 */
export function generateFingerprint(
  errorType: string,
  normalizedMessage: string,
  topFrame?: { file: string; function: string },
): string {
  const locationPart =
    topFrame !== undefined ? `${topFrame.file}:${topFrame.function}` : "";

  const input = [errorType, normalizedMessage, locationPart]
    .filter(Boolean)
    .join("|");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  const hex = hasher.digest("hex");

  const fingerprint = hex.slice(0, 16);
  logger.debug("Fingerprint generated", { errorType, fingerprint });
  return fingerprint;
}
