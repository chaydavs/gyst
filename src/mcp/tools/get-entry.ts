/**
 * MCP tool: get_entry
 *
 * DEPRECATED: prefer `read({ action: "get_entry", id })`. The legacy `get_entry`
 * tool remains for backward compat; the core logic is exported as
 * `handleGetEntry` so the unified `read` tool can dispatch to it.
 *
 * Fetches full detail of a single knowledge entry by id and returns a markdown
 * document with content, files, entities, tags, related entries, and evidence.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../register-tools.js";
import { getEntryById } from "../../store/entries.js";
import { formatAge } from "../../utils/age.js";
import { logger } from "../../utils/logger.js";

export const GetEntryInput = z.object({
  id: z.string().min(1),
  developer_id: z.string().optional(),
});

export type GetEntryInputType = z.infer<typeof GetEntryInput>;

interface FileRow {
  file_path: string;
}

interface TagRow {
  tag: string;
}

interface RelRow {
  other_id: string;
  type: string;
  strength: number;
}

interface EntryStubRow {
  id: string;
  title: string;
  type: string;
}

interface SourceRow {
  developer_id: string | null;
  tool: string | null;
  session_id: string | null;
  git_commit: string | null;
  timestamp: string;
}

function formatEvidenceLine(row: SourceRow): string {
  const date = row.timestamp.slice(0, 10);
  const who = row.developer_id ?? "unknown";
  const tool = row.tool ?? "unknown";
  const base = `${who} · ${tool} · ${date}`;
  if (row.git_commit !== null && row.git_commit.length > 0) {
    return `${base} (commit ${row.git_commit.slice(0, 7)})`;
  }
  return base;
}

function buildMarkdown(params: {
  entry: NonNullable<ReturnType<typeof getEntryById>>;
  files: readonly string[];
  entities: readonly string[];
  plainTags: readonly string[];
  related: ReadonlyArray<{ otherId: string; type: string; title: string }>;
  evidence: readonly SourceRow[];
}): string {
  const { entry, files, entities, plainTags, related, evidence } = params;

  const confidencePct = (entry.confidence * 100).toFixed(0);
  const age = formatAge(entry.createdAt);

  const lines: string[] = [
    `# ${entry.title}`,
    `**Type:** ${entry.type} · **Confidence:** ${confidencePct}% · **Age:** ${age} · **Scope:** ${entry.scope}`,
    "",
    entry.content,
  ];

  if (files.length > 0) {
    lines.push("", "## Files");
    for (const f of files) lines.push(`- ${f}`);
  }

  if (entities.length > 0) {
    lines.push("", "## Entities");
    for (const e of entities) lines.push(`- ${e}`);
  }

  if (plainTags.length > 0) {
    lines.push("", "## Tags");
    for (const t of plainTags) lines.push(`- ${t}`);
  }

  if (related.length > 0) {
    lines.push("", "## Related");
    for (const r of related) {
      lines.push(`- [${r.otherId}] ${r.type} → "${r.title}"`);
    }
  }

  if (evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const ev of evidence) lines.push(`- ${formatEvidenceLine(ev)}`);
  }

  return lines.join("\n");
}

/**
 * Fetches a single entry and its enrichments. Exported so the unified `read`
 * tool can call it.
 */
export async function handleGetEntry(
  ctx: ToolContext,
  input: GetEntryInputType,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { db } = ctx;
  logger.info("get_entry called", { id: input.id, developer_id: input.developer_id });

  const entry = getEntryById(db, input.id, input.developer_id);
  if (entry === null) {
    return {
      content: [{ type: "text" as const, text: `Entry not found: ${input.id}` }],
    };
  }

  const fileRows = db
    .query<FileRow, [string]>("SELECT file_path FROM entry_files WHERE entry_id = ?")
    .all(input.id);
  const files = fileRows.map((r) => r.file_path);

  const tagRows = db
    .query<TagRow, [string]>("SELECT tag FROM entry_tags WHERE entry_id = ?")
    .all(input.id);

  const ENTITY_PREFIX = "entity:";
  const entities: string[] = [];
  const plainTags: string[] = [];
  for (const { tag } of tagRows) {
    if (tag.startsWith(ENTITY_PREFIX)) {
      entities.push(tag.slice(ENTITY_PREFIX.length));
    } else {
      plainTags.push(tag);
    }
  }

  const relRows = db
    .query<RelRow, [string, string]>(`
      SELECT target_id AS other_id, type, strength
        FROM relationships WHERE source_id = ?
      UNION ALL
      SELECT source_id AS other_id, type, strength
        FROM relationships WHERE target_id = ?
    `)
    .all(input.id, input.id);

  const related: Array<{ otherId: string; type: string; title: string }> = [];
  if (relRows.length > 0) {
    const seen = new Set<string>();
    const uniqueRelRows: RelRow[] = [];
    for (const row of relRows) {
      if (!seen.has(row.other_id)) {
        seen.add(row.other_id);
        uniqueRelRows.push(row);
      }
    }

    const otherIds = uniqueRelRows.map((r) => r.other_id);
    const placeholders = otherIds.map(() => "?").join(", ");
    const stubRows = db
      .query<EntryStubRow, string[]>(
        `SELECT id, title, type FROM entries WHERE id IN (${placeholders})`,
      )
      .all(...otherIds);

    const stubMap = new Map(stubRows.map((s) => [s.id, s]));

    for (const row of uniqueRelRows) {
      const stub = stubMap.get(row.other_id);
      related.push({
        otherId: row.other_id,
        type: row.type,
        title: stub?.title ?? row.other_id,
      });
    }
  }

  let evidence: SourceRow[] = [];
  try {
    evidence = db
      .query<SourceRow, [string]>(`
        SELECT developer_id, tool, session_id, git_commit, timestamp
          FROM sources
         WHERE entry_id = ?
         ORDER BY timestamp DESC
         LIMIT 5
      `)
      .all(input.id);
  } catch {
    logger.info("get_entry: sources table unavailable, skipping evidence query");
  }

  const text = buildMarkdown({ entry, files, entities, plainTags, related, evidence });

  if (
    ctx.mode === "team" &&
    ctx.teamId !== undefined &&
    ctx.developerId !== undefined
  ) {
    const { logActivity } = await import("../../server/activity.js");
    logActivity(db, ctx.teamId, ctx.developerId, "get_entry");
  }

  return { content: [{ type: "text" as const, text }] };
}

export function registerGetEntryTool(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "get_entry",
    "[DEPRECATED — use `read` with action: \"get_entry\"] Fetch a knowledge entry by id. Still functional; will be removed in a future release.",
    GetEntryInput.shape,
    async (input: GetEntryInputType) => {
      logger.warn("get_entry tool is deprecated, use `read` with action: \"get_entry\"");
      const result = await handleGetEntry(ctx, input);
      const prefix = "⚠️ `get_entry` is deprecated — use `read({ action: \"get_entry\", id })`. Forwarding for now.\n\n";
      return {
        content: [{ type: "text" as const, text: prefix + (result.content[0]?.text ?? "") }],
      };
    },
  );
}
