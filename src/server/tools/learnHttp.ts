/**
 * HTTP-aware wrapper for the `learn` MCP tool.
 *
 * Delegates to the core learn tool implementation and appends an activity log
 * entry so the team can see what knowledge is being recorded.
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
import { loadConfig } from "../../utils/config.js";
import { logger } from "../../utils/logger.js";
import { DatabaseError, ValidationError } from "../../utils/errors.js";
import { logActivity } from "../activity.js";
import type { AuthContext } from "../auth.js";

// ---------------------------------------------------------------------------
// Input schema (identical to the stdio version)
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
// Internal row types
// ---------------------------------------------------------------------------

interface ExistingEntryRow {
  id: string;
  content: string;
  source_count: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Helpers (mirrors mcp/tools/learn.ts — kept here to avoid coupling)
// ---------------------------------------------------------------------------

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
    files: readonly string[];
    tags: readonly string[];
    now: string;
    scope: "personal" | "team" | "project";
    developerId?: string;
  },
  wikiDir: string,
): void {
  try {
    db.transaction(() => {
      db.run(
        `INSERT INTO entries
          (id, type, title, content, error_signature, confidence,
           source_count, created_at, last_confirmed, status, scope, developer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
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
          entry.developerId ?? null,
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
        `INSERT INTO sources (entry_id, tool, timestamp) VALUES (?, 'mcp-http', ?)`,
        [entry.id, entry.now],
      );
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to persist entry ${entry.id}: ${msg}`);
  }

  try {
    writeEntry(
      {
        id: entry.id,
        type: entry.type as "error_pattern" | "convention" | "decision" | "learning",
        title: entry.title,
        content: entry.content,
        files: [...entry.files],
        tags: [...entry.tags],
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
    logger.warn("Failed to write wiki markdown", {
      id: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function mergeIntoExisting(
  db: Database,
  existingId: string,
  incoming: { content: string; files: readonly string[]; tags: readonly string[]; now: string },
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
        "INSERT INTO sources (entry_id, tool, timestamp) VALUES (?, 'mcp-http', ?)",
        [existingId, incoming.now],
      );
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to merge into entry ${existingId}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `learn` tool on an HTTP-scoped MCP server.
 *
 * Identical to the stdio version but also logs activity for the calling
 * developer so team members can see what knowledge is being captured.
 *
 * @param server  - The McpServer instance to register on.
 * @param db      - Open bun:sqlite Database.
 * @param authCtx - Resolved auth context for the current HTTP session.
 */
export function registerHttpLearnTool(
  server: McpServer,
  db: Database,
  authCtx: AuthContext,
): void {
  server.tool(
    "learn",
    "Record team knowledge: error patterns, conventions, decisions, or learnings.",
    LearnInput.shape,
    async (input: LearnInputType) => {
      logger.info("learn tool called (http)", {
        type: input.type,
        title: input.title,
        developerId: authCtx.developerId,
      });

      const parseResult = LearnInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid learn input: ${msg}`);
      }

      const valid = parseResult.data;
      const safeContent = stripSensitiveData(valid.content);
      const safeErrorMessage =
        valid.error_message !== undefined
          ? stripSensitiveData(valid.error_message)
          : undefined;

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

      if (fingerprint !== undefined) {
        const existingRow = db
          .query<ExistingEntryRow, [string]>(
            "SELECT id, content, source_count, confidence FROM entries WHERE error_signature = ? AND status != 'archived' LIMIT 1",
          )
          .get(errorSignature!);

        if (existingRow !== null) {
          mergeIntoExisting(db, existingRow.id, {
            content: safeContent,
            files: valid.files,
            tags: valid.tags,
            now,
          });

          // Log activity for the calling developer
          if (authCtx.developerId !== null) {
            logActivity(db, authCtx.teamId, authCtx.developerId, "learn", existingRow.id, valid.files);
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

      const id = crypto.randomUUID();

      // Determine scope: use explicit input if provided, otherwise apply
      // type-based defaults (learning → personal; everything else → team).
      const defaultScope =
        valid.type === "learning" ? "personal" : "team";
      const resolvedScope: "personal" | "team" | "project" =
        valid.scope ?? defaultScope;

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
          tags: valid.tags,
          now,
          scope: resolvedScope,
          developerId: authCtx.developerId ?? undefined,
        },
        config.wikiDir,
      );

      // Log activity for the calling developer
      if (authCtx.developerId !== null) {
        logActivity(db, authCtx.teamId, authCtx.developerId, "learn", id, valid.files);
      }

      logger.info("New entry created (http)", {
        id,
        type: valid.type,
        developerId: authCtx.developerId,
      });

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
