/**
 * The `learn` MCP tool — agents record team knowledge.
 *
 * Accepts a knowledge entry (error pattern, convention, decision, or learning),
 * sanitises the content, deduplicates against existing entries, and persists
 * the result to both SQLite and the markdown wiki.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { stripSensitiveData } from "../../compiler/security.js";
import {
  normalizeErrorSignature,
  generateFingerprint,
} from "../../compiler/normalize.js";
import { writeEntry } from "../../compiler/writer.js";
import {
  extractEntities,
  extractEntitiesFromTitle,
} from "../../compiler/entities.js";
import { canLoadExtensions } from "../../store/database.js";
import { embedAndStore } from "../../store/embeddings.js";
import { loadConfig } from "../../utils/config.js";
import { logger } from "../../utils/logger.js";
import { DatabaseError, ValidationError } from "../../utils/errors.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const LearnInput = z.object({
  type: z.enum(["error_pattern", "convention", "decision", "learning"]),
  title: z.string().min(5).max(200),
  content: z.string().min(10).max(5000),
  files: z.array(z.string()).optional().default([]),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  scope: z.enum(["personal", "team", "project"]).optional(),
});

type LearnInputType = z.infer<typeof LearnInput>;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  content: string;
  source_count: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persists a new knowledge entry in a single transaction covering entries,
 * entry_files, entry_tags, sources, and FTS5 index tables.
 *
 * @param db - Open database connection.
 * @param entry - Fully-resolved entry data ready for storage.
 * @param wikiDir - Path to the wiki markdown directory.
 * @throws {DatabaseError} On any SQLite failure.
 */
function persistEntry(
  db: Database,
  entry: {
    id: string;
    type: string;
    title: string;
    content: string;
    errorSignature: string | undefined;
    fingerprint: string | undefined;
    confidence: number;
    sourceCount: number;
    files: string[];
    tags: string[];
    now: string;
    scope: "personal" | "team" | "project";
  },
  wikiDir: string,
): void {
  try {
    db.transaction(() => {
      db.run(
        `INSERT INTO entries
          (id, type, title, content, error_signature, confidence,
           source_count, created_at, last_confirmed, status, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [
          entry.id,
          entry.type,
          entry.title,
          entry.content,
          entry.errorSignature ?? null,
          entry.confidence,
          entry.sourceCount,
          entry.now,
          entry.now,
          entry.scope,
        ],
      );

      for (const filePath of entry.files) {
        db.run(
          "INSERT OR IGNORE INTO entry_files(entry_id, file_path) VALUES (?, ?)",
          [entry.id, filePath],
        );
      }

      for (const tag of entry.tags) {
        db.run(
          "INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?, ?)",
          [entry.id, tag],
        );
      }

      db.run(
        `INSERT INTO sources (entry_id, tool, timestamp)
         VALUES (?, 'mcp', ?)`,
        [entry.id, entry.now],
      );

      // Sync FTS5 content table (triggers handle this automatically on INSERT
      // but we do it explicitly for safety in case triggers are absent).
      const row = db
        .query<{ rowid: number }, [string]>(
          "SELECT rowid FROM entries WHERE id = ?",
        )
        .get(entry.id);

      if (row !== null) {
        db.run(
          `INSERT INTO entries_fts(rowid, title, content, error_signature)
           SELECT rowid, title, content, error_signature
           FROM   entries
           WHERE  id = ?`,
          [entry.id],
        );
      }
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to persist entry ${entry.id}: ${msg}`);
  }

  // Write markdown file outside the transaction (non-atomic I/O is acceptable
  // here; if it fails the DB entry still exists and can be re-exported).
  try {
    writeEntry(
      {
        id: entry.id,
        type: entry.type as "error_pattern" | "convention" | "decision" | "learning",
        title: entry.title,
        content: entry.content,
        files: entry.files,
        tags: entry.tags,
        errorSignature: entry.errorSignature,
        fingerprint: entry.fingerprint,
        confidence: entry.confidence,
        sourceCount: entry.sourceCount,
        createdAt: entry.now,
        lastConfirmed: entry.now,
        status: "active",
        scope: entry.scope,
      },
      wikiDir,
    );
  } catch (err) {
    // Log but do not re-throw — markdown write failure is recoverable.
    logger.warn("Failed to write wiki markdown", {
      id: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Merges new data into an existing entry: increments source_count, unions
 * files and tags, updates content if newer, and updates last_confirmed.
 *
 * @param db - Open database connection.
 * @param existingId - The `id` of the existing entry to merge into.
 * @param incoming - Incoming entry data.
 * @throws {DatabaseError} On any SQLite failure.
 */
function mergeIntoExisting(
  db: Database,
  existingId: string,
  incoming: {
    content: string;
    files: string[];
    tags: string[];
    now: string;
  },
): void {
  try {
    db.transaction(() => {
      db.run(
        `UPDATE entries
         SET content        = ?,
             source_count   = source_count + 1,
             last_confirmed = ?
         WHERE id = ?`,
        [incoming.content, incoming.now, existingId],
      );

      for (const filePath of incoming.files) {
        db.run(
          "INSERT OR IGNORE INTO entry_files(entry_id, file_path) VALUES (?, ?)",
          [existingId, filePath],
        );
      }

      for (const tag of incoming.tags) {
        db.run(
          "INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?, ?)",
          [existingId, tag],
        );
      }

      db.run(
        "INSERT INTO sources (entry_id, tool, timestamp) VALUES (?, 'mcp', ?)",
        [existingId, incoming.now],
      );
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to merge into entry ${existingId}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `learn` tool on the given MCP server.
 *
 * The tool accepts structured knowledge, sanitises it, checks for duplicates,
 * and persists to SQLite + the markdown wiki.
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerLearnTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "learn",
    "Record team knowledge: error patterns, conventions, decisions, or learnings. Use this whenever you discover something worth remembering for the team.",
    LearnInput.shape,
    async (input: LearnInputType) => {
      logger.info("learn tool called", { type: input.type, title: input.title });

      // Validate input
      const parseResult = LearnInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid learn input: ${msg}`);
      }

      const valid = parseResult.data;

      // Sanitise free-text fields
      const safeContent = stripSensitiveData(valid.content);
      const safeErrorMessage =
        valid.error_message !== undefined
          ? stripSensitiveData(valid.error_message)
          : undefined;

      // Build error signature and fingerprint for error_pattern type
      let errorSignature: string | undefined;
      let fingerprint: string | undefined;

      if (valid.type === "error_pattern" && safeErrorMessage !== undefined) {
        errorSignature = normalizeErrorSignature(safeErrorMessage);
        if (valid.error_type !== undefined) {
          fingerprint = generateFingerprint(valid.error_type, errorSignature);
        }
      }

      const config = loadConfig();
      const now = new Date().toISOString();

      // Check for duplicate by fingerprint
      if (fingerprint !== undefined) {
        const existingRow = db
          .query<EntryRow, [string]>(
            "SELECT id, content, source_count, confidence FROM entries WHERE error_signature = ? AND status != 'archived' LIMIT 1",
          )
          .get(errorSignature!);

        if (existingRow !== null) {
          logger.info("Duplicate entry detected, merging", {
            existingId: existingRow.id,
            fingerprint,
          });

          mergeIntoExisting(db, existingRow.id, {
            content: safeContent,
            files: valid.files,
            tags: valid.tags,
            now,
          });

          // Log activity when running in team mode with a known developer
          if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
            const { logActivity } = await import("../../server/activity.js");
            logActivity(ctx.db, ctx.teamId, ctx.developerId, "learn", existingRow.id, valid.files);
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Updated existing entry (merged): "${valid.title}" — source count now ${existingRow.source_count + 1}.`,
              },
            ],
          };
        }
      }

      // Persist as new entry
      const id = crypto.randomUUID();

      // Determine scope: use explicit input if provided, otherwise apply
      // mode-based defaults. In team mode all entries default to "team";
      // in personal mode learnings default to "personal", others to "team".
      const defaultScope: "personal" | "team" =
        ctx.mode === "team"
          ? "team"
          : valid.type === "learning"
            ? "personal"
            : "team";
      const resolvedScope: "personal" | "team" | "project" =
        valid.scope ?? defaultScope;

      // Extract code entities from content and title, then attach as
      // prefixed tags so graph search can match queries like "getToken function".
      // Uses the existing tags column — no schema change required.
      const contentEntities = extractEntities(safeContent);
      const titleEntities = extractEntitiesFromTitle(valid.title);
      const allEntities = [...contentEntities, ...titleEntities];
      const entityTags = allEntities.map((e) => `entity:${e.name}`);
      const dedupedEntityTags = [...new Set(entityTags)];
      const mergedTags = [...valid.tags, ...dedupedEntityTags];

      persistEntry(
        db,
        {
          id,
          type: valid.type,
          title: valid.title,
          content: safeContent,
          errorSignature,
          fingerprint,
          confidence: 0.5,
          sourceCount: 1,
          files: valid.files,
          tags: mergedTags,
          now,
          scope: resolvedScope,
        },
        config.wikiDir,
      );

      // Strategy 5: Store a semantic embedding for this entry when the
      // vector store is available. Fire-and-forget — a failed embedding
      // must not block the learn call. The catch handler logs and
      // swallows errors so the caller still sees a successful write.
      if (canLoadExtensions()) {
        const embeddingText = `${valid.title}\n\n${safeContent}`;
        embedAndStore(db, id, embeddingText).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("embed on learn failed", { id, error: msg });
        });
      }

      // Auto-link new entry to existing entries sharing entities
      const linkingEntities = [
        ...extractEntities(safeContent),
        ...extractEntitiesFromTitle(valid.title),
      ];
      if (linkingEntities.length > 0) {
        const { createRelationship } = await import("../../compiler/linker.js");
        const seenTargets = new Set<string>();
        for (const entity of linkingEntities) {
          const rows = db
            .query<{ entry_id: string }, [string, string]>(
              "SELECT DISTINCT entry_id FROM entry_tags WHERE tag = ? AND entry_id != ?",
            )
            .all(`entity:${entity.name}`, id);
          for (const row of rows) {
            if (!seenTargets.has(row.entry_id) && seenTargets.size < 20) {
              seenTargets.add(row.entry_id);
              createRelationship(db, id, row.entry_id, "related_to");
            }
          }
        }
        if (seenTargets.size > 0) {
          logger.info("Entity-linked new entry", { id, entityLinks: seenTargets.size });
        }
      }

      logger.info("New entry created", { id, type: valid.type, title: valid.title });

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "learn", id, valid.files);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Learned: "${valid.title}" (${valid.type}, id: ${id})`,
          },
        ],
      };
    },
  );
}
