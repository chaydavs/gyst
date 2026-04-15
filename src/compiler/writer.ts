/**
 * Markdown writer for the Gyst compiler layer.
 *
 * Converts a {@link KnowledgeEntry} into a markdown file with YAML frontmatter
 * and writes it to the `gyst-wiki/` directory tree. The file path is derived
 * from the entry type and a kebab-case slug of its title.
 *
 * Uses gray-matter's `stringify()` to guarantee valid frontmatter output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import matter from "gray-matter";
import type { KnowledgeEntry } from "./extract.js";
import { logger } from "../utils/logger.js";
import { ValidationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts a title string into a URL-safe, kebab-case slug.
 *
 * @param title - Human-readable entry title.
 * @returns Lowercase kebab-case slug (e.g. `"my-cool-entry"`).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // strip non-alphanumeric except spaces/hyphens
    .trim()
    .replace(/\s+/g, "-") // spaces → hyphens
    .replace(/-{2,}/g, "-") // collapse consecutive hyphens
    .replace(/^-|-$/g, ""); // strip leading/trailing hyphens
}

/**
 * Renders a {@link KnowledgeEntry} as a markdown string with YAML frontmatter.
 *
 * Frontmatter fields:
 * - `type` — entry category
 * - `confidence` — current confidence score (2 decimal places)
 * - `last_confirmed` — ISO-8601 timestamp
 * - `sources` — source count
 * - `affects` — list of related file paths (omitted when empty)
 * - `tags` — list of tags (omitted when empty)
 * - `supersedes` — id of superseded entry (omitted when absent)
 *
 * Body:
 * - `# {title}` heading
 * - `{content}` paragraph
 * - A **Fix** section for `error_pattern` entries (when content is long enough)
 * - An **Evidence** section listing files and source count
 *
 * @param entry - The knowledge entry to render.
 * @returns Complete markdown string ready to write to disk.
 */
export function entryToMarkdown(entry: KnowledgeEntry): string {
  const frontmatter: Record<string, unknown> = {
    type: entry.type,
    confidence: parseFloat(entry.confidence.toFixed(2)),
    last_confirmed: entry.lastConfirmed ?? new Date().toISOString(),
    sources: entry.sourceCount,
  };

  if (entry.files.length > 0) {
    frontmatter["affects"] = [...entry.files];
  }

  if (entry.tags.length > 0) {
    frontmatter["tags"] = [...entry.tags];
  }

  // Body sections assembled immutably
  const bodyParts: string[] = [`# ${entry.title}`, "", entry.content];

  if (entry.type === "error_pattern") {
    bodyParts.push("", "## Fix", "", entry.content);
  }

  const evidenceParts: string[] = ["", "## Evidence", ""];

  if (entry.files.length > 0) {
    evidenceParts.push("**Affected files:**");
    for (const file of entry.files) {
      evidenceParts.push(`- \`${file}\``);
    }
    evidenceParts.push("");
  }

  evidenceParts.push(`**Sources:** ${entry.sourceCount}`);

  const body = [...bodyParts, ...evidenceParts].join("\n");

  return matter.stringify(body, frontmatter);
}

/**
 * Writes a {@link KnowledgeEntry} to a markdown file inside `wikiDir`.
 *
 * File path: `{wikiDir}/{type}/{slug}-{id[:8]}.md`
 *
 * Parent directories are created if they do not exist.
 *
 * @param entry - The knowledge entry to persist.
 * @param wikiDir - Absolute path to the wiki output directory (e.g. `"gyst-wiki"`).
 * @returns The absolute path of the file that was written.
 * @throws {ValidationError} If the entry title produces an empty slug.
 */
export function writeEntry(entry: KnowledgeEntry, wikiDir: string): string {
  const slug = slugify(entry.title);
  if (slug.length === 0) {
    throw new ValidationError(
      `Cannot derive a valid slug from title: "${entry.title}"`,
    );
  }

  const shortId = entry.id.slice(0, 8);
  const relativePath = join(entry.type, `${slug}-${shortId}.md`);
  const filePath = join(wikiDir, relativePath);

  const markdown = entryToMarkdown(entry);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, markdown, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Re-throw with context so callers get a descriptive message
    throw new Error(`Failed to write wiki entry to ${filePath}: ${msg}`);
  }

  logger.info("Wiki entry written", {
    id: entry.id,
    type: entry.type,
    path: filePath,
  });

  return filePath;
}
