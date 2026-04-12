/**
 * Structured fact extraction for the Gyst compiler layer.
 *
 * Takes raw learn-tool input, applies the security filter, normalises error
 * signatures when applicable, and returns a fully-typed {@link KnowledgeEntry}
 * ready for deduplication and storage.
 */

import { z } from "zod";
import { stripSensitiveData } from "./security.js";
import { normalizeErrorSignature, generateFingerprint } from "./normalize.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// KnowledgeEntry schema and type
// ---------------------------------------------------------------------------

/** Zod schema for a compiled knowledge entry. */
export const KnowledgeEntrySchema = z.object({
  id: z.string(),
  type: z.enum(["error_pattern", "convention", "decision", "learning"]),
  title: z.string().min(5).max(200),
  content: z.string().min(10).max(5000),
  files: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  errorType: z.string().optional(),
  errorMessage: z.string().optional(),
  errorSignature: z.string().optional(),
  fingerprint: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceCount: z.number().default(1),
  sourceTool: z.string().optional(),
  createdAt: z.string().optional(),
  lastConfirmed: z.string().optional(),
  status: z
    .enum(["active", "stale", "conflicted", "archived"])
    .default("active"),
  scope: z.enum(["personal", "team", "project"]).default("team"),
  developerId: z.string().optional(),
});

/** A compiled knowledge entry produced by the extraction pipeline. */
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

// ---------------------------------------------------------------------------
// LearnInput schema and type
// ---------------------------------------------------------------------------

/**
 * Raw input schema accepted by the `learn` MCP tool.
 * This is the shape of data that arrives from Claude Code / Cursor before
 * any processing.
 */
export const LearnInputSchema = z.object({
  /** One of the four canonical knowledge types. */
  type: z.enum(["error_pattern", "convention", "decision", "learning"]),
  /** Short human-readable title for the entry. */
  title: z.string().min(5).max(200),
  /** Full description, explanation, or fix instructions. */
  content: z.string().min(10).max(5000),
  /** Source files related to this entry. */
  files: z.array(z.string()).optional().default([]),
  /** Free-form tags for categorisation. */
  tags: z.array(z.string()).optional().default([]),
  /** Error class name (e.g. `"TypeError"`). Only for `error_pattern`. */
  errorType: z.string().optional(),
  /** Raw error message text. Only for `error_pattern`. */
  errorMessage: z.string().optional(),
  /** Initial confidence score (0–1). Defaults to 0.5. */
  confidence: z.number().min(0).max(1).optional(),
  /** Which tool or integration submitted this entry. */
  sourceTool: z.string().optional(),
  /**
   * Visibility scope for this entry.
   * Defaults are applied per type if not explicitly provided:
   *   - convention, decision, error_pattern → "team"
   *   - learning → "personal"
   */
  scope: z.enum(["personal", "team", "project"]).optional(),
});

/** Raw input from the learn MCP tool. */
export type LearnInput = z.infer<typeof LearnInputSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts a structured {@link KnowledgeEntry} from raw {@link LearnInput}.
 *
 * Processing steps:
 * 1. Validate the input against {@link LearnInputSchema}.
 * 2. Strip sensitive data from `content` and `errorMessage`.
 * 3. For `error_pattern` entries, normalise the error message and generate
 *    a fingerprint for deduplication.
 * 4. Assign a random UUID as the entry `id`.
 * 5. Stamp `createdAt` and `lastConfirmed` with the current ISO timestamp.
 *
 * @param input - Raw learn input to process.
 * @returns A fully-typed {@link KnowledgeEntry} ready for deduplication.
 * @throws {ValidationError} If `input` fails schema validation.
 */
export function extractEntry(input: LearnInput): KnowledgeEntry {
  // 1. Validate raw input
  const parsed = LearnInputSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Invalid learn input: ${message}`);
  }

  const valid = parsed.data;

  // 2. Strip sensitive data from free-text fields
  const safeContent = stripSensitiveData(valid.content);
  const safeErrorMessage =
    valid.errorMessage !== undefined
      ? stripSensitiveData(valid.errorMessage)
      : undefined;

  // 3. Normalise error signatures for error_pattern entries
  let errorSignature: string | undefined;
  let fingerprint: string | undefined;

  if (valid.type === "error_pattern" && safeErrorMessage !== undefined) {
    errorSignature = normalizeErrorSignature(safeErrorMessage);

    if (valid.errorType !== undefined) {
      fingerprint = generateFingerprint(valid.errorType, errorSignature);
    }

    logger.debug("Error pattern extracted", {
      errorType: valid.errorType,
      fingerprint,
    });
  }

  // 4. Build the entry (immutable — construct a new object, never mutate)
  const now = new Date().toISOString();

  // Determine scope: use explicit input if provided, otherwise apply
  // type-based defaults (learning → personal; everything else → team).
  const defaultScope =
    valid.type === "learning" ? "personal" : "team";
  const resolvedScope: "personal" | "team" | "project" =
    valid.scope ?? defaultScope;

  const entry: KnowledgeEntry = {
    id: crypto.randomUUID(),
    type: valid.type,
    title: valid.title,
    content: safeContent,
    files: [...valid.files],
    tags: [...valid.tags],
    errorType: valid.errorType,
    errorMessage: safeErrorMessage,
    errorSignature,
    fingerprint,
    confidence: valid.confidence ?? 0.5,
    sourceCount: 1,
    sourceTool: valid.sourceTool,
    createdAt: now,
    lastConfirmed: now,
    status: "active",
    scope: resolvedScope,
  };

  logger.info("Knowledge entry extracted", {
    id: entry.id,
    type: entry.type,
    title: entry.title,
  });

  return entry;
}
