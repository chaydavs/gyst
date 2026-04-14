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
  const eligible = conventions.filter((c) => c.confidence >= MIN_CONFIDENCE);

  logger.info("store-conventions: storing detected conventions", {
    total: conventions.length,
    eligible: eligible.length,
    skippedLowConfidence: conventions.length - eligible.length,
  });

  let stored = 0;

  for (const convention of eligible) {
    try {
      await addManualEntry(db, {
        type: "convention",
        title: buildTitle(convention),
        content: buildContent(convention),
        tags: [convention.directory, convention.category],
        files: [`${convention.directory}/`],
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

  logger.info("store-conventions: done", { stored, eligible: eligible.length });

  return stored;
}
