/**
 * Manual knowledge entry creation for the Gyst CLI.
 *
 * Handles input validation, sensitive-data stripping, database insertion,
 * markdown file writing, and FTS5 indexing for entries added via `gyst add`.
 */

import type { Database } from "bun:sqlite";
import { stripSensitiveData } from "../compiler/security.js";
import { extractEntry } from "../compiler/extract.js";
import type { LearnInput } from "../compiler/extract.js";
import { writeEntry } from "../compiler/writer.js";
import { insertEntry } from "../store/database.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Accepted entry types mirroring the database schema. */
export type EntryType =
  | "error_pattern"
  | "convention"
  | "decision"
  | "learning";

/** Input shape for a manually created knowledge entry. */
export interface ManualInput {
  readonly type: EntryType;
  readonly title: string;
  readonly content: string;
  readonly files?: readonly string[];
  readonly tags?: readonly string[];
  /**
   * Visibility scope. Optional — when omitted, `extractEntry` applies type-based
   * defaults (personal, except ghost_knowledge which defaults to team).
   */
  readonly scope?: "personal" | "team" | "project";
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_TYPES: ReadonlySet<EntryType> = new Set([
  "error_pattern",
  "convention",
  "decision",
  "learning",
]);

const MAX_TITLE_LENGTH = 256;
const MAX_CONTENT_LENGTH = 32_000;

/**
 * Validates a `ManualInput` object and throws `ValidationError` on failure.
 *
 * @param input - The raw input to validate.
 * @throws {ValidationError} When any field fails its constraint.
 */
function validateInput(input: ManualInput): void {
  if (!VALID_TYPES.has(input.type)) {
    throw new ValidationError(
      `Invalid entry type "${input.type}". Must be one of: ${[...VALID_TYPES].join(", ")}`,
    );
  }

  const title = input.title.trim();
  if (title.length === 0) {
    throw new ValidationError("Entry title must not be empty");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Entry title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`,
    );
  }

  const content = input.content.trim();
  if (content.length === 0) {
    throw new ValidationError("Entry content must not be empty");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new ValidationError(
      `Entry content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
    );
  }
}

// ---------------------------------------------------------------------------
// addManualEntry
// ---------------------------------------------------------------------------

/**
 * Validates, sanitizes, stores, and indexes a manually supplied knowledge entry.
 *
 * Steps:
 *   1. Validate `input` against field constraints.
 *   2. Strip secrets / sensitive data from title and content.
 *   3. Delegate to `extractEntry` to generate a stable ID and apply defaults.
 *   4. Insert the entry row into the `entries` SQLite table.
 *   5. Write a canonical markdown file under the wiki directory.
 *   6. Index the entry in the FTS5 virtual table for full-text search.
 *
 * @param db    - An open Bun SQLite database handle (caller owns lifecycle).
 * @param input - Raw user-supplied knowledge entry.
 * @returns The newly assigned entry ID (UUID v4 string).
 * @throws {ValidationError} If the input fails validation.
 * @throws {DatabaseError}   If the database write fails.
 */
export async function addManualEntry(
  db: Database,
  input: ManualInput,
): Promise<string> {
  // 1. Validate
  validateInput(input);

  // 2. Strip sensitive data (immutable — returns new strings)
  const safeTitle = stripSensitiveData(input.title.trim());
  const safeContent = stripSensitiveData(input.content.trim());
  const safeFiles = input.files?.map((f) => stripSensitiveData(f)) ?? [];
  const safeTags = input.tags?.map((t) => t.trim().toLowerCase()) ?? [];

  const safeInput: ManualInput = {
    type: input.type,
    title: safeTitle,
    content: safeContent,
    files: safeFiles,
    tags: safeTags,
    scope: input.scope,
  };

  // 3. Extract entry (generate ID, normalize fields)
  // LearnInputSchema requires content >= 10 chars. For short CLI inputs like
  // `gyst add "auth flow" "broken"`, prepend the title so the entry is
  // descriptive enough for FTS5 and semantic search to index meaningfully.
  const minContentLength = 10;
  const effectiveContent =
    safeContent.length < minContentLength
      ? `${safeTitle}: ${safeContent}`
      : safeContent;

  const learnInput: LearnInput = {
    type: safeInput.type,
    title: safeInput.title,
    content: effectiveContent,
    files: [...safeFiles],
    tags: [...safeTags],
    scope: safeInput.scope,
  };
  const entry = extractEntry(learnInput);

  // 4. Insert into database (FTS5 is auto-synced via trigger)
  insertEntry(db, entry);

  // 5. Embed for semantic search if available
  const { canLoadExtensions } = await import("../store/database.js");
  if (canLoadExtensions()) {
    try {
      const { initVectorStore, embedAndStore } = await import("../store/embeddings.js");
      initVectorStore(db);
      await embedAndStore(db, entry.id, `${entry.title}\n\n${entry.content}`);
    } catch (err) {
      logger.warn("Failed to embed manual entry", { id: entry.id, error: String(err) });
    }
  }

  // 6. Write markdown file
  const config = loadConfig();
  writeEntry(entry, config.wikiDir);

  logger.info("Manual entry created", {
    entryId: entry.id,
    type: entry.type,
    title: entry.title,
  });

  return entry.id;
}
