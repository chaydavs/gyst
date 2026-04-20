/**
 * The unified `check` MCP tool.
 *
 * Merges three previously separate tools behind a single entry point:
 *   - action: "violations"  (default) — run the violation engine against a file
 *   - action: "conventions"           — list team conventions that apply to a path
 *   - action: "failures"              — look up known error patterns by message
 *
 * The legacy `check_conventions` and `failures` tools remain registered (with
 * deprecation prefixes) for backward compat. The action-less call to `check`
 * keeps the original violations behavior so existing agents do not break.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { checkFileViolations } from "../../compiler/check-violations.js";
import {
  normalizeErrorSignature,
  generateFingerprint,
} from "../../compiler/normalize.js";
import { searchByBM25 } from "../../store/search.js";
import { loadConfig } from "../../utils/config.js";
import { truncateToTokenBudget } from "../../utils/tokens.js";
import { logger } from "../../utils/logger.js";
import { ValidationError } from "../../utils/errors.js";
import type { ToolContext } from "../register-tools.js";

// ---------------------------------------------------------------------------
// Input schema (unified)
// ---------------------------------------------------------------------------

const CheckInput = z.object({
  action: z
    .enum(["violations", "conventions", "failures"])
    .optional()
    .default("violations")
    .describe(
      'What to run: "violations" (scan a file), "conventions" (list rules for a path), "failures" (look up a known error).',
    ),
  file_path: z.string().min(1).max(1000).optional(),
  content: z.string().max(200_000).optional(),
  error_message: z.string().min(5).optional(),
  error_type: z.string().optional(),
  developer_id: z.string().optional(),
});

type CheckInputType = z.infer<typeof CheckInput>;

const SEVERITY_ICON: Record<"error" | "warning" | "info", string> = {
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

// ---------------------------------------------------------------------------
// Handlers — one per action. Exported so legacy tools can delegate.
// ---------------------------------------------------------------------------

export async function handleCheckViolations(
  ctx: ToolContext,
  input: { file_path: string; content?: string; developer_id?: string },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("check violations called", { file_path: input.file_path });

  const violations = checkFileViolations(db, input.file_path, input.content);

  let report = `Checking ${input.file_path} against conventions...\n\n`;
  if (violations.length === 0) {
    report += "No violations found.";
  } else {
    for (const v of violations) {
      const icon = SEVERITY_ICON[v.severity];
      const lineLabel = v.line > 0 ? `Line ${v.line} ` : "";
      report += `${icon} ${lineLabel}[${v.severity}] ${v.rule}\n`;
      report += `   ${v.message}\n`;
      if (v.suggestion !== undefined) {
        report += `   Suggestion: ${v.suggestion}\n`;
      }
      report += "\n";
    }
    report += `${violations.length} violation(s) found.`;
  }

  if (
    ctx.mode === "team" &&
    ctx.developerId !== undefined &&
    ctx.teamId !== undefined
  ) {
    const { logActivity } = await import("../../server/activity.js");
    logActivity(ctx.db, ctx.teamId, ctx.developerId, "check", undefined, [
      input.file_path,
    ]);
  }

  return { content: [{ type: "text" as const, text: report }] };
}

// ---- Conventions lookup (was `check_conventions`) ------------------------

interface ConventionRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
}

function fetchConventionsByFilePath(db: Database, filePath: string): ConventionRow[] {
  return db
    .query<ConventionRow, [string]>(
      `SELECT DISTINCT e.id, e.title, e.content, e.confidence
       FROM   entries e
       JOIN   entry_files ef ON ef.entry_id = e.id
       WHERE  e.type   = 'convention'
         AND  e.status = 'active'
         AND  ? LIKE ef.file_path || '%'
       ORDER  BY e.confidence DESC
       LIMIT  10`,
    )
    .all(filePath);
}

function fetchConventionsByDirectoryTag(db: Database, filePath: string): ConventionRow[] {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return [];
  const directory = filePath.slice(0, lastSlash);

  return db
    .query<ConventionRow, [string]>(
      `SELECT DISTINCT e.id, e.title, e.content, e.confidence
       FROM   entries e
       JOIN   entry_tags et ON et.entry_id = e.id
       WHERE  e.type   = 'convention'
         AND  e.status = 'active'
         AND  et.tag = ?
       ORDER  BY e.confidence DESC
       LIMIT  10`,
    )
    .all(directory);
}

function mergeConventions(a: ConventionRow[], b: ConventionRow[]): ConventionRow[] {
  const seen = new Map<string, ConventionRow>();
  for (const row of [...a, ...b]) {
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return Array.from(seen.values()).sort((x, y) => y.confidence - x.confidence);
}

function formatConventions(rows: ConventionRow[], filePath: string): string {
  if (rows.length === 0) {
    return "No conventions recorded for this path yet.";
  }
  const header = `Conventions for ${filePath}:\n`;
  const sections = rows.map((row) =>
    [
      `## ${row.title} (confidence: ${row.confidence.toFixed(2)})`,
      row.content,
      "---",
    ].join("\n"),
  );
  return header + "\n" + sections.join("\n\n");
}

export async function handleCheckConventions(
  ctx: ToolContext,
  input: { file_path: string },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("check conventions called", { file_path: input.file_path });

  const byFilePath = fetchConventionsByFilePath(db, input.file_path);
  const byDirTag = fetchConventionsByDirectoryTag(db, input.file_path);
  const rows = mergeConventions(byFilePath, byDirTag);

  logger.info("check conventions results", {
    file_path: input.file_path,
    byFilePath: byFilePath.length,
    byDirTag: byDirTag.length,
    merged: rows.length,
  });

  if (
    ctx.mode === "team" &&
    ctx.developerId !== undefined &&
    ctx.teamId !== undefined
  ) {
    const { logActivity } = await import("../../server/activity.js");
    logActivity(ctx.db, ctx.teamId, ctx.developerId, "check_conventions");
  }

  return {
    content: [{ type: "text" as const, text: formatConventions(rows, input.file_path) }],
  };
}

// ---- Failures lookup (was `failures`) ------------------------------------

interface FailureRow {
  id: string;
  title: string;
  content: string;
  confidence: number;
  error_signature: string | null;
}

function searchFailuresBySignature(db: Database, signature: string): FailureRow[] {
  return db
    .query<FailureRow, [string]>(
      `SELECT id, title, content, confidence, error_signature
       FROM   entries
       WHERE  error_signature = ?
         AND  type   = 'error_pattern'
         AND  status = 'active'
       ORDER  BY confidence DESC`,
    )
    .all(signature);
}

function fetchFailuresByIds(db: Database, ids: string[]): FailureRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<FailureRow, string[]>(
      `SELECT id, title, content, confidence, error_signature
       FROM   entries
       WHERE  id IN (${placeholders})
         AND  type   = 'error_pattern'
         AND  status = 'active'
       ORDER  BY confidence DESC`,
    )
    .all(...ids);
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

function formatFailures(rows: FailureRow[], maxTokens: number): string {
  if (rows.length === 0) return "No known error patterns found matching this error.";
  const header = `Found ${rows.length} known error pattern(s):\n\n`;
  const sections = rows.map((row) =>
    [
      `## ${row.title} (confidence: ${row.confidence.toFixed(2)})`,
      row.content,
      "---",
    ].join("\n"),
  );
  return truncateToTokenBudget(header + sections.join("\n\n"), maxTokens);
}

export async function handleCheckFailures(
  ctx: ToolContext,
  input: { error_message: string; error_type?: string; file?: string },
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("check failures called", {
    error_type: input.error_type,
    file: input.file,
  });

  const config = loadConfig();
  const normalised = normalizeErrorSignature(input.error_message);
  const fingerprint =
    input.error_type !== undefined
      ? generateFingerprint(input.error_type, normalised)
      : undefined;

  logger.debug("check failures normalised", { normalised, fingerprint });

  let rows = searchFailuresBySignature(db, normalised);
  if (rows.length === 0) {
    const bm25Results = searchByBM25(db, normalised, "error_pattern");
    const ids = bm25Results.slice(0, 5).map((r) => r.id);
    rows = fetchFailuresByIds(db, ids);
  }

  const filtered = rows.filter((r) => r.confidence >= config.confidenceThreshold);

  logger.info("check failures results", {
    total: rows.length,
    afterFilter: filtered.length,
  });

  if (
    ctx.mode === "team" &&
    ctx.developerId !== undefined &&
    ctx.teamId !== undefined
  ) {
    const { logActivity } = await import("../../server/activity.js");
    const fileList = input.file !== undefined ? [input.file] : undefined;
    logActivity(ctx.db, ctx.teamId, ctx.developerId, "failures", undefined, fileList);
  }

  return {
    content: [
      { type: "text" as const, text: formatFailures(filtered, config.maxRecallTokens) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatchCheck(
  ctx: ToolContext,
  input: CheckInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  switch (input.action) {
    case "conventions": {
      if (!input.file_path) {
        throw new ValidationError('check action "conventions" requires file_path.');
      }
      return handleCheckConventions(ctx, { file_path: input.file_path });
    }
    case "failures": {
      if (!input.error_message) {
        throw new ValidationError('check action "failures" requires error_message.');
      }
      return handleCheckFailures(ctx, {
        error_message: input.error_message,
        error_type: input.error_type,
        file: input.file_path,
      });
    }
    case "violations":
    default: {
      if (!input.file_path) {
        throw new ValidationError('check action "violations" requires file_path.');
      }
      return handleCheckViolations(ctx, {
        file_path: input.file_path,
        content: input.content,
        developer_id: input.developer_id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Registration — unified `check` tool
// ---------------------------------------------------------------------------

/**
 * Registers the unified `check` tool on the given MCP server.
 *
 * Uses the `action` parameter to pick the behavior:
 *   - "violations" (default): scan a file against active conventions
 *   - "conventions":          list conventions applicable to a file/directory
 *   - "failures":             look up a known error pattern by message
 */
export function registerCheckTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "check",
    "Check code against team knowledge. action=\"violations\" (default) scans a file for convention violations; action=\"conventions\" lists rules that apply to a path; action=\"failures\" looks up a known error pattern by its message.",
    CheckInput.shape,
    async (input: CheckInputType) => {
      const parseResult = CheckInput.safeParse(input);
      if (!parseResult.success) {
        const msg = parseResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid check input: ${msg}`);
      }
      return dispatchCheck(ctx, parseResult.data);
    },
  );
}
