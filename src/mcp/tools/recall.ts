/**
 * The `recall` MCP tool — agents search team knowledge.
 *
 * Runs three complementary search strategies (file-path, BM25, graph), fuses
 * the results with Reciprocal Rank Fusion, filters by confidence threshold,
 * and returns formatted results within a token budget.
 *
 * The optional `context_budget` parameter allows callers to specify a tighter
 * token budget for self-hosted models (e.g. Ollama with 4096-token context).
 * When omitted, the budget defaults to `config.maxRecallTokens` (5000).
 * Four formatting tiers adapt automatically:
 *   5000+  → full (title, body, files, tags)
 *   2000–4999 → compact (top 3, first 2 sentences)
 *   800–1999  → minimal (top 2, 80-char summary)
 *   < 800     → ultra-minimal (top 1, first sentence)
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import type { ToolContext } from "../register-tools.js";
import {
  searchByFilePath,
  searchByBM25,
  searchByGraph,
  searchByTemporal,
  reciprocalRankFusion,
} from "../../store/search.js";
import { canLoadExtensions } from "../../store/database.js";
import { searchByVector } from "../../store/embeddings.js";
import { loadConfig } from "../../utils/config.js";
import { formatForContext } from "../../utils/format-recall.js";
import { logger } from "../../utils/logger.js";
import { emitEvent } from "../../store/events.js";
import { getStructuralForEntries } from "../../store/structural.js";
import { trackRecall, initAnalyticsSchema } from "../../utils/analytics.js";
import type { IntentBucket } from "../../utils/analytics.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const RecallInput = z.object({
  /**
   * Operating mode — controls what this tool does:
   *   - 'search' (default): full ranked recall with RRF fusion (current behavior)
   *   - 'index': compact token-efficient index (id · type · confidence · title); use before get_entry
   *   - 'single': fetch full content for one entry by id (pass id in query)
   *   - 'conventions': list team coding standards by directory/tags
   *   - 'failures': look up known error patterns by error message
   */
  mode: z
    .enum(["search", "index", "single", "conventions", "failures"])
    .optional()
    .default("search"),
  query: z.string().min(1).max(500),
  type: z
    .enum(["error_pattern", "convention", "decision", "learning", "ghost_knowledge", "all"])
    .optional()
    .default("all"),
  files: z.array(z.string()).optional().default([]),
  max_results: z.number().min(1).max(10).optional().default(5),
  scope: z.enum(["personal", "team", "project"]).optional(),
  developer_id: z.string().optional(),
  /**
   * Maximum tokens allowed in the formatted response.
   *
   * Use this to adapt recall output to the caller's available context window:
   *   - Claude Code / Cursor: omit (defaults to config.maxRecallTokens = 5000)
   *   - Ollama / small models: 2000
   *   - Ultra-tight contexts:   800–1000
   *
   * Must be between 200 and 20000.
   */
  context_budget: z.number().int().min(200).max(20000).optional(),
  /** For mode='single': the entry id to fetch. Alias: use query field. */
  id: z.string().optional(),
  /** For mode='conventions': directory prefix filter. */
  directory: z.string().optional(),
  /** For mode='conventions': tag filter. */
  tags: z.array(z.string()).optional(),
  /** For mode='failures': the error message to look up. */
  error_message: z.string().optional(),
  /** For mode='failures': optional error type for fingerprinting. */
  error_type: z.string().optional(),
});

type RecallInputType = z.infer<typeof RecallInput>;

// ---------------------------------------------------------------------------
// Database row type
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  status: string;
}

// FormattableEntry is imported from format-recall; EntryRow satisfies its shape.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts the number of .md files (excluding index.md) in `dir` recursively.
 * Returns 0 if the directory does not exist.
 */
function countWikiFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countWikiFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      count += 1;
    }
  }
  return count;
}

/**
 * Fetches full entry data for a list of ids from the database, applying
 * scope-based visibility rules.
 *
 * Visibility rules:
 *  - "team" and "project" scope entries are visible to everyone.
 *  - "personal" scope entries are only visible when `developerId` matches.
 *  - If no `developerId` is provided, only team and project entries are shown.
 *
 * @param db - Open database connection.
 * @param ids - List of entry ids to fetch.
 * @param developerId - Optional caller identity for personal entry access.
 * @returns Array of entry rows in the order the ids were provided.
 */
function fetchEntries(
  db: Database,
  ids: string[],
  developerId?: string,
  includeAllPersonal = false,
): EntryRow[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");

  let sql: string;
  let params: string[];

  if (developerId !== undefined) {
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
        AND  (scope IN ('team', 'project')
              OR (scope = 'personal' AND developer_id = ?))
    `;
    params = [...ids, developerId];
  } else if (includeAllPersonal) {
    // Personal mode with no developer_id — single user, all entries are theirs.
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
    `;
    params = [...ids];
  } else {
    sql = `
      SELECT id, type, title, content, confidence, scope, status
      FROM   entries
      WHERE  id IN (${placeholders})
        AND  status IN ('active', 'consolidated')
        AND  scope IN ('team', 'project')
    `;
    params = [...ids];
  }

  const rows = db.query<EntryRow, string[]>(sql).all(...params);

  // Preserve the RRF rank order.
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = rowMap.get(id);
    return row !== undefined ? [row] : [];
  });
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `recall` tool on the given MCP server.
 *
 * Runs three search strategies in parallel, fuses results via RRF, filters by
 * confidence, and returns formatted knowledge within the configured token budget.
 *
 * The optional `context_budget` parameter overrides `config.maxRecallTokens` so
 * self-hosted models with small context windows (e.g. Ollama @ 4096 tokens) can
 * request a tighter output. Four formatting tiers are selected automatically:
 *   >= 5000  → full (up to 5 entries, title + body + files + tags)
 *   >= 2000  → compact (up to 3 entries, first 2 sentences)
 *   >= 800   → minimal (up to 2 entries, 80-char summary)
 *   < 800    → ultra-minimal (1 entry, first sentence only)
 *
 * @param server - The McpServer instance to register on.
 * @param ctx - Tool context containing db, mode, and optional team identifiers.
 */
export function registerRecallTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;
  server.tool(
    "recall",
    "Search team knowledge. mode='search' (default): full ranked results. mode='index': compact id/type/title list (7× fewer tokens). mode='single': full entry by id. mode='conventions': coding standards by directory/tags. mode='failures': known error patterns by error_message. Use before writing code to surface team rules, errors, and decisions.",
    RecallInput.shape,
    async (input: RecallInputType) => {
      const mode = input.mode ?? "search";

      // --- mode='index': delegate to search tool logic ---
      if (mode === "index") {
        emitEvent(db, "tool_use", { tool: "recall:index", query: input.query });
        logger.info("recall[index] called", { query: input.query });

        const { fetchEntriesByIds } = await import("../../store/entries.js");
        const { formatAge } = await import("../../utils/age.js");
        const config = loadConfig();
        const typeFilter = input.type === "all" ? undefined : input.type;
        const developerId = input.developer_id;
        const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;

        const semanticPromise = canLoadExtensions()
          ? searchByVector(db, input.query, 20, developerId).catch((err: unknown) => {
              logger.warn("searchByVector failed", { error: err instanceof Error ? err.message : String(err) });
              return [];
            })
          : Promise.resolve([]);

        const [fileResults, bm25Results, graphResults, temporalResults, vectorResults] =
          await Promise.all([
            Promise.resolve(searchByFilePath(db, input.files ?? [])),
            Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId, includeAllPersonal)),
            Promise.resolve(searchByGraph(db, input.query)),
            Promise.resolve(searchByTemporal(db, input.query)),
            semanticPromise,
          ]);

        const { classifyIntent, applyIntentBoost } = await import("../../store/intent.js");
        const intent = classifyIntent(input.query);
        const temporalWeight = (intent === "debugging" || intent === "history")
          ? [temporalResults, temporalResults]
          : [temporalResults];

        const rawFused = reciprocalRankFusion([fileResults, bm25Results, graphResults, ...temporalWeight, vectorResults]);
        const limit = input.max_results ?? 10;
        const topIds = rawFused.slice(0, limit * 3).map((r) => r.id);
        const entries = fetchEntriesByIds(db, topIds, developerId, includeAllPersonal);

        const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));
        const boostedScores = new Map(
          entries.map((e) => {
            const base = scoreMap.get(e.id) ?? 0;
            let boosted = base;
            if (e.type === "ghost_knowledge") boosted = Math.min(1.0, base + 0.15);
            else if (e.type === "convention") boosted = Math.min(1.0, base + 0.05);
            return [e.id, boosted] as const;
          }),
        );
        const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);
        const sortedEntries = [...entries].sort((a, b) => {
          const aIsGhost = a.type === "ghost_knowledge" ? 0 : 1;
          const bIsGhost = b.type === "ghost_knowledge" ? 0 : 1;
          const tierDiff = aIsGhost - bIsGhost;
          if (tierDiff !== 0) return tierDiff;
          return (intentBoostedScores.get(b.id) ?? 0) - (intentBoostedScores.get(a.id) ?? 0);
        });
        const filtered = sortedEntries
          .filter((e) => e.type === "ghost_knowledge" || e.confidence >= config.confidenceThreshold)
          .slice(0, limit);

        if (filtered.length === 0) {
          return { content: [{ type: "text" as const, text: `No results found for: ${input.query}` }] };
        }

        const lines: string[] = [`Found ${filtered.length} results. Use recall(mode='single', id=...) for full detail.`, ""];
        for (const entry of filtered) {
          const confidence = `${(entry.confidence * 100).toFixed(0)}%`;
          const age = formatAge(entry.createdAt);
          lines.push(`${entry.id} · ${entry.type} · ${confidence} · ${age}`);
          lines.push(entry.title);
          lines.push(`ref: gyst://entry/${entry.id}`);
          lines.push("");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }] };
      }

      // --- mode='single': fetch full entry by id ---
      if (mode === "single") {
        if (!input.id) {
          return {
            content: [{
              type: "text" as const,
              text: "mode='single' requires an `id` parameter. Use mode='search' to search by text.",
            }],
          };
        }

        const entryId = input.id;
        emitEvent(db, "tool_use", { tool: "recall:single", id: entryId });
        logger.info("recall[single] called", { id: entryId });

        const { getEntryById } = await import("../../store/entries.js");
        const { formatAge } = await import("../../utils/age.js");
        const entry = getEntryById(db, entryId, input.developer_id);
        if (entry === null) {
          return { content: [{ type: "text" as const, text: `Entry not found: ${entryId}` }] };
        }

        const fileRows = db.query<{ file_path: string }, [string]>(
          "SELECT file_path FROM entry_files WHERE entry_id = ?",
        ).all(entryId);
        const files = fileRows.map((r) => r.file_path);

        const tagRows = db.query<{ tag: string }, [string]>(
          "SELECT tag FROM entry_tags WHERE entry_id = ?",
        ).all(entryId);
        const ENTITY_PREFIX = "entity:";
        const entities: string[] = [];
        const plainTags: string[] = [];
        for (const { tag } of tagRows) {
          if (tag.startsWith(ENTITY_PREFIX)) entities.push(tag.slice(ENTITY_PREFIX.length));
          else plainTags.push(tag);
        }

        // Query relationships (bidirectional), then batch-fetch titles.
        interface RelRow { other_id: string; type: string; strength: number; }
        interface EntryStubRow { id: string; title: string; type: string; }
        const relRows = db.query<RelRow, [string, string]>(`
          SELECT target_id AS other_id, type, strength
            FROM relationships WHERE source_id = ?
          UNION ALL
          SELECT source_id AS other_id, type, strength
            FROM relationships WHERE target_id = ?
        `).all(entryId, entryId);

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
          const stubRows = db.query<EntryStubRow, string[]>(
            `SELECT id, title, type FROM entries WHERE id IN (${placeholders})`,
          ).all(...otherIds);
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

        // Query sources/evidence — guard against missing table.
        interface SourceRow {
          developer_id: string | null;
          tool: string | null;
          session_id: string | null;
          git_commit: string | null;
          timestamp: string;
        }
        let evidence: SourceRow[] = [];
        try {
          evidence = db.query<SourceRow, [string]>(`
            SELECT developer_id, tool, session_id, git_commit, timestamp
              FROM sources
             WHERE entry_id = ?
             ORDER BY timestamp DESC
             LIMIT 5
          `).all(entryId);
        } catch {
          logger.info("recall[single]: sources table unavailable, skipping evidence query");
        }

        const confidencePct = (entry.confidence * 100).toFixed(0);
        const age = formatAge(entry.createdAt);
        const lines: string[] = [
          `# ${entry.title}`,
          `**Type:** ${entry.type} · **Confidence:** ${confidencePct}% · **Age:** ${age} · **Scope:** ${entry.scope}`,
          "",
          entry.content,
        ];
        if (files.length > 0) { lines.push("", "## Files"); for (const f of files) lines.push(`- ${f}`); }
        if (entities.length > 0) { lines.push("", "## Entities"); for (const e of entities) lines.push(`- ${e}`); }
        if (plainTags.length > 0) { lines.push("", "## Tags"); for (const t of plainTags) lines.push(`- ${t}`); }
        if (related.length > 0) {
          lines.push("", "## Related");
          for (const r of related) lines.push(`- [${r.otherId}] ${r.type} → "${r.title}"`);
        }
        if (evidence.length > 0) {
          lines.push("", "## Evidence");
          for (const ev of evidence) {
            const date = ev.timestamp.slice(0, 10);
            const who = ev.developer_id ?? "unknown";
            const tool = ev.tool ?? "unknown";
            const base = `${who} · ${tool} · ${date}`;
            const line = (ev.git_commit !== null && ev.git_commit.length > 0)
              ? `${base} (commit ${ev.git_commit.slice(0, 7)})`
              : base;
            lines.push(`- ${line}`);
          }
        }
        lines.push("", `ref: gyst://entry/${entry.id}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // --- mode='conventions': fetch team coding standards ---
      if (mode === "conventions") {
        emitEvent(db, "tool_use", { tool: "recall:conventions" });
        logger.info("recall[conventions] called", { directory: input.directory, tags: input.tags });

        const { truncateToTokenBudget } = await import("../../utils/tokens.js");
        const config = loadConfig();
        const directory = input.directory;
        const tags = input.tags;

        const hasDirectory = directory !== undefined && directory.length > 0;
        const hasTags = tags !== undefined && tags.length > 0;

        interface ConventionRow { id: string; title: string; content: string; confidence: number; }
        let rows: ConventionRow[];

        if (!hasDirectory && !hasTags) {
          rows = db.query<ConventionRow, []>(
            `SELECT e.id, e.title, e.content, e.confidence
             FROM   entries e
             WHERE  e.type = 'convention' AND e.status = 'active'
             ORDER  BY e.confidence DESC`,
          ).all();
        } else {
          const conditions: string[] = ["e.type = 'convention'", "e.status = 'active'"];
          const params: string[] = [];
          const joins: string[] = [];
          if (hasDirectory) {
            joins.push("LEFT JOIN entry_files ef ON ef.entry_id = e.id");
            conditions.push("ef.file_path LIKE ?");
            params.push(`${directory}%`);
          }
          if (hasTags) {
            joins.push("LEFT JOIN entry_tags et ON et.entry_id = e.id");
            const tagPlaceholders = tags!.map(() => "?").join(", ");
            conditions.push(`et.tag IN (${tagPlaceholders})`);
            params.push(...tags!);
          }
          const sql = `SELECT DISTINCT e.id, e.title, e.content, e.confidence FROM entries e ${joins.join(" ")} WHERE ${conditions.join(" AND ")} ORDER BY e.confidence DESC`;
          rows = db.query<ConventionRow, string[]>(sql).all(...params);
        }

        logger.info("recall[conventions] results", { count: rows.length });
        if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
          const { logActivity } = await import("../../server/activity.js");
          logActivity(ctx.db, ctx.teamId, ctx.developerId, "conventions");
        }

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No conventions found for the given context." }] };
        }
        const sections = rows.map((row) =>
          [`## ${row.title} (confidence: ${row.confidence.toFixed(2)})`, row.content, "---"].join("\n"),
        );
        const formatted = truncateToTokenBudget(sections.join("\n\n"), config.maxRecallTokens);
        return { content: [{ type: "text" as const, text: formatted }] };
      }

      // --- mode='failures': look up known error patterns ---
      if (mode === "failures") {
        const errorMessage = input.error_message ?? input.query;
        emitEvent(db, "tool_use", { tool: "recall:failures" });
        logger.info("recall[failures] called", { error_type: input.error_type });

        const { normalizeErrorSignature, generateFingerprint } = await import("../../compiler/normalize.js");
        const { truncateToTokenBudget } = await import("../../utils/tokens.js");
        const config = loadConfig();

        const normalised = normalizeErrorSignature(errorMessage);
        // Fingerprint generated for future use (exact-match path); currently
        // we rely on normalised signature for the exact-match query.
        if (input.error_type !== undefined) {
          generateFingerprint(input.error_type, normalised);
        }

        interface FailureRow { id: string; title: string; content: string; confidence: number; error_signature: string | null; }

        let rows = db.query<FailureRow, [string]>(
          `SELECT id, title, content, confidence, error_signature
           FROM   entries
           WHERE  error_signature = ? AND type = 'error_pattern' AND status = 'active'
           ORDER  BY confidence DESC`,
        ).all(normalised);

        if (rows.length === 0) {
          const bm25Results = searchByBM25(db, normalised, "error_pattern");
          const ids = bm25Results.slice(0, 5).map((r) => r.id);
          if (ids.length > 0) {
            const placeholders = ids.map(() => "?").join(", ");
            rows = db.query<FailureRow, string[]>(
              `SELECT id, title, content, confidence, error_signature
               FROM   entries
               WHERE  id IN (${placeholders}) AND type = 'error_pattern' AND status = 'active'
               ORDER  BY confidence DESC`,
            ).all(...ids);
          }
        }

        const filtered = rows.filter((r) => r.confidence >= config.confidenceThreshold);
        logger.info("recall[failures] results", { total: rows.length, afterFilter: filtered.length });

        if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
          const { logActivity } = await import("../../server/activity.js");
          logActivity(ctx.db, ctx.teamId, ctx.developerId, "failures");
        }

        if (filtered.length === 0) {
          return { content: [{ type: "text" as const, text: "No known error patterns found matching this error." }] };
        }
        const header = `Found ${filtered.length} known error pattern(s):\n\n`;
        const sections = filtered.map((row) =>
          [`## ${row.title} (confidence: ${row.confidence.toFixed(2)})`, row.content, "---"].join("\n"),
        );
        const formatted = truncateToTokenBudget(header + sections.join("\n\n"), config.maxRecallTokens);
        return { content: [{ type: "text" as const, text: formatted }] };
      }

      // --- mode='search' (default): original recall behavior, unchanged ---
      emitEvent(db, "tool_use", { tool: "recall", query: input.query });

      logger.info("recall tool called", {
        query: input.query,
        type: input.type,
        scope: input.scope,
        developer_id: input.developer_id,
        context_budget: input.context_budget,
      });

      const config = loadConfig();
      const typeFilter = input.type === "all" ? undefined : input.type;
      const developerId = input.developer_id;
      // In personal mode with no developer_id, all stored entries belong to
      // the single user — drop scope filtering entirely so they are visible.
      const includeAllPersonal = ctx.mode === "personal" && developerId === undefined;

      // Resolve the effective token budget: explicit parameter takes priority
      // over the configured default so callers on small context windows can
      // request a reduced output.
      const budget = input.context_budget ?? config.maxRecallTokens;

      // Run all five search strategies in parallel. Semantic is skipped
      // gracefully when the SQLite binary can't load extensions.
      const semanticPromise = canLoadExtensions()
        ? searchByVector(db, input.query, 20, developerId).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("searchByVector failed — falling back", { error: msg });
            return [];
          })
        : Promise.resolve([]);

      const [
        fileResults,
        bm25Results,
        graphResults,
        temporalResults,
        vectorResults,
      ] = await Promise.all([
        Promise.resolve(searchByFilePath(db, input.files ?? [])),
        Promise.resolve(searchByBM25(db, input.query, typeFilter, developerId, includeAllPersonal)),
        Promise.resolve(searchByGraph(db, input.query)),
        Promise.resolve(searchByTemporal(db, input.query)),
        semanticPromise,
      ]);

      logger.debug("Search strategy results", {
        fileResults: fileResults.length,
        bm25Results: bm25Results.length,
        graphResults: graphResults.length,
        temporalResults: temporalResults.length,
        vectorResults: vectorResults.length,
      });

      // Classify intent to weight temporal results and apply per-type boosts.
      const { classifyIntent, applyIntentBoost } = await import("../../store/intent.js");
      const intent = classifyIntent(input.query);
      // For debugging/history intents, double-weight temporal results (rank-based cheapest weighting).
      const temporalWeight = (intent === "debugging" || intent === "history")
        ? [temporalResults, temporalResults]
        : [temporalResults];

      // Fuse with Reciprocal Rank Fusion (empty lists are ignored by RRF)
      const rawFused = reciprocalRankFusion([
        fileResults,
        bm25Results,
        graphResults,
        ...temporalWeight,
        vectorResults,
      ]);

      // Filter by minimum confidence (use RRF score as proxy pre-fetch,
      // then re-filter after hydrating with actual confidence values).
      const topIds = rawFused
        .slice(0, (input.max_results ?? 5) * 3) // over-fetch; default 5 when Zod defaults not applied
        .map((r) => r.id);

      const entries = fetchEntries(db, topIds, developerId, includeAllPersonal);

      // Build a score map from the fused results so we can apply the ghost
      // knowledge boost before re-sorting.
      const scoreMap = new Map(rawFused.map((r) => [r.id, r.score]));

      const boostedScores = new Map(
        entries.map((e) => {
          const base = scoreMap.get(e.id) ?? 0;
          let boosted = base;
          if (e.type === "ghost_knowledge") {
            boosted = Math.min(1.0, base + 0.15);
          } else if (e.type === "convention" && (input.files ?? []).length > 0) {
            // Boost conventions relevant to the requested file directories.
            // We don't have entry_files in the fetched rows, so use a small
            // unconditional convention boost when files are provided — the
            // directory-match check happens at the conventions tool layer.
            // Simple heuristic: boost all conventions slightly when files given.
            boosted = Math.min(1.0, base + 0.05);
          }
          // Consolidated entries are merged team summaries — boost them above
          // individual raw learnings so the distilled knowledge surfaces first.
          if (e.status === "consolidated") {
            boosted = Math.min(1.0, boosted + 0.10);
          }
          return [e.id, boosted] as const;
        }),
      );

      // Apply intent-aware boosting on top of ghost/convention boosts.
      const intentBoostedScores = applyIntentBoost(entries, boostedScores, intent);

      // Sort by priority tier first, then by boosted score within each tier.
      // Tier 0: ghost_knowledge (always surfaces first — mandatory constraints)
      // Tier 1: convention (coding standards relevant to this context)
      // Tier 2: everything else (ordered by score)
      const tierOf = (type: string): number => {
        if (type === "ghost_knowledge") return 0;
        if (type === "convention") return 1;
        return 2;
      };

      const sortedEntries = [...entries].sort((a, b) => {
        const tierDiff = tierOf(a.type) - tierOf(b.type);
        if (tierDiff !== 0) return tierDiff;
        return (intentBoostedScores.get(b.id) ?? 0) - (intentBoostedScores.get(a.id) ?? 0);
      });

      // Apply confidence threshold — ghost_knowledge is always included
      // regardless of threshold (confidence is 1.0 by spec, but be explicit
      // here so a misconfigured threshold can never suppress them).
      let filtered = sortedEntries
        .filter(
          (e) =>
            e.type === "ghost_knowledge" ||
            e.confidence >= config.confidenceThreshold,
        )
        .slice(0, input.max_results ?? 5);

      // --- Global Personal Memory Fallback ---
      // If local repo search yields no results, check the global home database.
      let isGlobalResult = false;
      if (filtered.length === 0 && ctx.globalDb) {
        logger.info("Local recall yields no results, checking global memory");
        // Reuse same search strategies against global DB
        // For brevity we run BM25 and Semantic only for global fallback
        const [gBm25, gVec] = await Promise.all([
          Promise.resolve(searchByBM25(ctx.globalDb, input.query, typeFilter, undefined, true)),
          canLoadExtensions() ? searchByVector(ctx.globalDb, input.query, 5, undefined) : Promise.resolve([])
        ]);
        
        const gFused = reciprocalRankFusion([gBm25, gVec]);
        if (gFused.length > 0) {
          const gTopIds = gFused.slice(0, input.max_results ?? 5).map(r => r.id);
          const gEntries = fetchEntries(ctx.globalDb, gTopIds, undefined, true);
          if (gEntries.length > 0) {
            filtered = gEntries;
            isGlobalResult = true;
          }
        }
      }

      // Record co-retrieval for strengthening over time — best-effort, never throws.
      if (filtered.length >= 2 && !isGlobalResult) {
        try {
          const { recordCoRetrieval } = await import("../../store/graph.js");
          recordCoRetrieval(db, filtered.slice(0, 5).map((e) => e.id));
        } catch (err) {
          logger.warn("recordCoRetrieval failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("recall results", {
        total: entries.length,
        afterFilter: filtered.length,
        confidenceThreshold: config.confidenceThreshold,
        budget,
      });

      // Prefix ghost_knowledge entry titles with the team-rule warning emoji
      // so agents immediately recognise mandatory constraints.
      const formattableEntries = filtered.map((e) => {
        let titlePrefix = "";
        if (isGlobalResult) titlePrefix = "🌎 Global Memory: ";
        
        if (e.type === "ghost_knowledge") {
          return { ...e, title: `${titlePrefix}⚠️ Team Rule: ${e.title}` };
        }
        if (e.type === "convention") {
          return { ...e, title: `${titlePrefix}📏 Convention: ${e.title}` };
        }
        return { ...e, title: `${titlePrefix}${e.title}` };
      });

      let formatted = formatForContext(formattableEntries, budget);

      // Phase B.3: attach an adjacent structural sidecar (graphify AST) for
      // the files touched by the top-ranked curated results. Strictly
      // post-retrieval — never interleaved with the ranked list and only when
      // headroom remains in the context budget (keep at most ~200 tokens).
      if (!isGlobalResult && filtered.length > 0 && budget >= 1500) {
        try {
          const topIds = filtered.slice(0, 5).map((e) => e.id);
          const adjacent = getStructuralForEntries(db, topIds, input.files ?? [], 5);
          if (adjacent.length > 0) {
            const lines = adjacent.map(
              (s) =>
                `  • ${s.label}${s.sourceLocation ? ` @${s.sourceLocation}` : ""} — ${s.filePath}`,
            );
            formatted +=
              "\n\n📐 Structural context (graphify, adjacent — not ranked):\n" +
              lines.join("\n");
          }
        } catch (err) {
          logger.warn("recall: structural adjacent lookup failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Staleness warning: zero results on a non-trivial query may indicate
      // the SQLite index is out of sync with the wiki markdown files.
      if (filtered.length === 0 && input.query.length > 5) {
        const wikiDir = loadConfig().wikiDir;
        const fileCount = countWikiFiles(wikiDir);
        const dbCount =
          (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entries WHERE status = 'active'").get()?.n ?? 0);
        if (fileCount > dbCount) {
          formatted +=
            "\n\n⚠️ Knowledge base may be stale (wiki has more files than the index). Run 'gyst rebuild' or restart your agent.";
        }
      }

      // Log activity when running in team mode with a known developer
      if (ctx.mode === "team" && ctx.developerId !== undefined && ctx.teamId !== undefined) {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(ctx.db, ctx.teamId, ctx.developerId, "recall", undefined, input.files ?? []);
      }

      // Local analytics — stored in this project's own SQLite, never transmitted
      const intentBucketMap: Record<string, IntentBucket> = {
        temporal: "temporal", debugging: "debugging",
        code_quality: "code_quality", conventions: "code_quality",
        conceptual: "conceptual", onboarding: "conceptual", search: "conceptual",
      };
      const intentBucket: IntentBucket = intentBucketMap[intent] ?? "conceptual";
      initAnalyticsSchema(db);
      trackRecall(db, {
        resultCount: filtered.length,
        tokenProxy: Math.round(formatted.length / 4),
        intent: intentBucket,
        zeroResult: filtered.length === 0,
        teamMode: ctx.mode === "team",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatted,
          },
        ],
      };
    },
  );
}
