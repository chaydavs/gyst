/**
 * Persists auto-detected conventions to the Gyst database.
 *
 * Bridges detectConventions() (pure read-only analysis) with the
 * addManualEntry() storage pipeline so the MCP check_conventions
 * tool can surface these entries during recall.
 */

import type { Database } from "bun:sqlite";
import { addManualEntry } from "../capture/manual.js";
import type { DetectedConvention } from "./detect-conventions.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

/**
 * Which of the 6 knowledge types best describes this category?
 *
 * Prior behaviour: every DetectedConvention was stored as `type="convention"`.
 * That's technically correct (they're all coding conventions) but erased the
 * sub-shape — `custom_errors` is really a team-wide error_pattern library,
 * not a naming rule. Mapping it separately lets the dashboard and `failures`
 * tool surface error-handling choices alongside actual error signatures.
 *
 * The other seven categories stay `convention` — they describe how the team
 * writes code, not what breaks. If we add more categories that are truly
 * "what to do when X happens" (retries, rate-limits, etc.), they'd map to
 * `learning` or `decision`.
 */
function mapCategoryToType(
  category: DetectedConvention["category"],
): "convention" | "error_pattern" {
  return category === "custom_errors" ? "error_pattern" : "convention";
}

/**
 * Collapses per-directory detections into a single project-level convention
 * when the same (category, pattern) appears in `minDirs` or more directories.
 *
 * Why: the old pipeline emitted "Naming: src/api uses camelCase" AND
 * "Naming: src/store uses camelCase" AND "Naming: src/compiler uses camelCase"
 * as three separate entries — the bloat the user observed as "100 conventions".
 * If ≥3 directories agree, it's a project-wide convention, not a local one.
 * If fewer agree, the per-directory entries are kept so divergences surface.
 */
const PROJECT_WIDE_MIN_DIRS = 3;

function consolidateConventions(
  conventions: readonly DetectedConvention[],
): DetectedConvention[] {
  const groups = new Map<string, DetectedConvention[]>();
  for (const c of conventions) {
    const key = `${c.category}::${c.pattern}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  const out: DetectedConvention[] = [];
  for (const list of groups.values()) {
    if (list.length < PROJECT_WIDE_MIN_DIRS) {
      out.push(...list);
      continue;
    }
    const first = list[0]!;
    const totalScanned = list.reduce((sum, c) => sum + c.evidence.filesScanned, 0);
    const totalMatching = list.reduce((sum, c) => sum + c.evidence.filesMatching, 0);
    const examples = list
      .flatMap((c) => c.evidence.examples)
      .slice(0, 3);
    const avgConfidence = list.reduce((sum, c) => sum + c.confidence, 0) / list.length;
    out.push({
      category: first.category,
      directory: "src",
      pattern: first.pattern,
      confidence: avgConfidence,
      evidence: {
        filesScanned: totalScanned,
        filesMatching: totalMatching,
        examples,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

interface ExistingConventionRow {
  title: string;
}

/**
 * Returns a Set of normalised title keys for every active convention already
 * stored in the database.  Used to prevent inserting duplicate entries when
 * `storeDetectedConventions` is called multiple times on the same codebase.
 *
 * The key format matches `buildTitle()` so a direct equality check is enough.
 */
function loadExistingConventionTitles(db: Database): Set<string> {
  const rows = db
    .query<ExistingConventionRow, []>(
      `SELECT title FROM entries WHERE type = 'convention' AND status = 'active'`,
    )
    .all();
  return new Set(rows.map((r) => r.title));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conventions below this threshold are too weak to surface as a rule. */
const MIN_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capitalizes the first letter of a string.
 * Returns a new string — does not mutate the original.
 */
function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Builds a human-readable title for a detected convention.
 *
 * Format: "<Category>: <directory> uses <pattern>"
 * e.g. "Naming: src/api uses camelCase functions"
 */
function buildTitle(convention: DetectedConvention): string {
  return `${capitalize(convention.category)}: ${convention.directory} uses ${convention.pattern}`;
}

/**
 * Builds a markdown content block describing a detected convention,
 * including pattern details, confidence, and evidence.
 */
function buildContent(convention: DetectedConvention): string {
  const examplesBlock =
    convention.evidence.examples.length > 0
      ? `Examples:\n${convention.evidence.examples.map((e) => `- ${e}`).join("\n")}`
      : "";

  return [
    `Auto-detected convention for ${convention.directory}.`,
    "",
    `Pattern: ${convention.pattern}`,
    `Category: ${convention.category}`,
    `Confidence: ${(convention.confidence * 100).toFixed(0)}%`,
    "",
    `Evidence: ${convention.evidence.filesMatching} of ${convention.evidence.filesScanned} files match this pattern.`,
    ...(examplesBlock ? [examplesBlock] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts an array of auto-detected conventions into database entries.
 *
 * Each DetectedConvention becomes a convention entry with:
 *   - type: "convention"
 *   - title: "<Category>: <directory> uses <pattern>"
 *   - content: markdown description with evidence details
 *   - tags: [directory, category]
 *   - files: [directory + "/"] so check_conventions can find it by path
 *   - confidence: from DetectedConvention.confidence
 *   - scope: "team"
 *
 * Skips conventions below 0.6 confidence (too weak to surface as a rule).
 * Each insertion is wrapped in try/catch — individual failures are logged
 * as warnings but do not abort the remaining entries.
 *
 * @param db          - Open bun:sqlite Database connection (caller owns lifecycle).
 * @param conventions - Detected conventions from detectConventions().
 * @returns Number of entries successfully stored.
 */
export async function storeDetectedConventions(
  db: Database,
  conventions: DetectedConvention[],
): Promise<number> {
  // Step 1: consolidate cross-directory duplicates into project-wide
  // entries BEFORE confidence filtering — the consolidated entry's
  // evidence is stronger than any individual directory's.
  const consolidated = consolidateConventions(conventions);
  const eligible = consolidated.filter((c) => c.confidence >= MIN_CONFIDENCE);

  // Load titles already in the database so we can skip exact duplicates.
  const existingTitles = loadExistingConventionTitles(db);

  const toStore = eligible.filter(
    (c) => !existingTitles.has(buildTitle(c)),
  );
  const skippedDuplicates = eligible.length - toStore.length;

  // Auto-detected conventions are a project-wide signal. If the user has
  // opted into team mode, they land in the team layer; otherwise they
  // stay personal so the shared team folder stays empty until explicitly
  // initialised.
  let teamMode = false;
  try {
    teamMode = loadConfig().teamMode;
  } catch {
    teamMode = false;
  }
  const resolvedScope: "personal" | "team" = teamMode ? "team" : "personal";

  logger.info("store-conventions: storing detected conventions", {
    total: conventions.length,
    consolidated: consolidated.length,
    eligible: eligible.length,
    skippedLowConfidence: consolidated.length - eligible.length,
    skippedDuplicates,
    toStore: toStore.length,
    scope: resolvedScope,
  });

  let stored = 0;

  for (const convention of toStore) {
    try {
      await addManualEntry(db, {
        type: mapCategoryToType(convention.category),
        title: buildTitle(convention),
        content: buildContent(convention),
        tags: [convention.directory, convention.category],
        files: [`${convention.directory}/`],
        scope: resolvedScope,
      });
      stored++;
    } catch (err) {
      logger.warn("store-conventions: failed to store convention entry", {
        directory: convention.directory,
        category: convention.category,
        pattern: convention.pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("store-conventions: done", {
    stored,
    eligible: eligible.length,
    skippedDuplicates,
  });

  return stored;
}
