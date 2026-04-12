/**
 * The `harvest` MCP tool — automatically extract knowledge from a
 * coding session transcript.
 *
 * The adoption driver for Gyst: install, run a coding session, and
 * knowledge entries build themselves without explicit learn() calls.
 * The agent calls this at session end (or on PreCompact) with the
 * full transcript, and Gyst turns the raw text into structured
 * error patterns, decisions, conventions, and learnings.
 *
 * Processing pipeline:
 *   1. Noise filter — drop pure code output, system prompts, tool blocks
 *   2. Pattern extraction — regex-based scanning for the 4 entry types
 *   3. Pairing — error descriptions are linked with nearby fix descriptions
 *   4. Pipeline reuse — every extracted item is passed through the
 *      existing learn pipeline (extract -> normalize -> dedupe -> store)
 *      so deduplication against prior knowledge is automatic
 *   5. Session tracking — writes to the `sources` table keyed by session_id
 *      so re-harvesting the same session is a no-op
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "bun:sqlite";
import { extractEntry } from "../../compiler/extract.js";
import type { LearnInput } from "../../compiler/extract.js";
import { stripSensitiveData } from "../../compiler/security.js";
import { findDuplicate } from "../../compiler/deduplicate.js";
import { insertEntry } from "../../store/database.js";
import { logger } from "../../utils/logger.js";
import { ValidationError } from "../../utils/errors.js";

const HarvestInputSchema = z.object({
  transcript: z.string().min(1).max(100_000),
  session_id: z.string().optional(),
  developer_id: z.string().optional(),
});

type HarvestInputType = z.infer<typeof HarvestInputSchema>;

export interface HarvestResult {
  readonly entriesCreated: number;
  readonly entriesMerged: number;
  readonly entriesSkipped: number;
}

export interface HarvestParams {
  readonly transcript: string;
  readonly session_id?: string;
  readonly developer_id?: string;
}

/**
 * Registers the harvest tool on the given MCP server.
 *
 * @param server - The McpServer instance to register on.
 * @param db - Open bun:sqlite Database.
 */
export function registerHarvestTool(server: McpServer, db: Database): void {
  server.tool(
    "harvest",
    "Extract knowledge entries from a coding session transcript. Filters noise, pattern-matches decisions/errors/conventions/learnings, and stores them via the normal learn pipeline with automatic deduplication.",
    HarvestInputSchema.shape,
    async (input: HarvestInputType) => {
      logger.info("harvest tool called", { session_id: input.session_id });

      const parsed = HarvestInputSchema.safeParse(input);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new ValidationError(`Invalid harvest input: ${msg}`);
      }

      const result = harvestTranscript(db, parsed.data);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Harvest complete: ${result.entriesCreated} created, ` +
              `${result.entriesMerged} merged, ${result.entriesSkipped} skipped.`,
          },
        ],
      };
    },
  );
}

/**
 * Processes a session transcript: filters noise, extracts knowledge
 * candidates, deduplicates, and persists new entries.
 *
 * Returns a HarvestResult describing how many entries were created,
 * merged, or skipped. This function never throws — all per-candidate errors
 * are caught and counted as skipped so the PreCompact hook path is safe.
 *
 * @param db - Open database connection.
 * @param params - Transcript and optional session/developer identifiers.
 * @returns Summary counts for the harvest run.
 */
export function harvestTranscript(
  db: Database,
  params: HarvestParams,
): HarvestResult {
  if (params.session_id !== undefined) {
    const existing = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sources WHERE session_id = ?",
      )
      .get(params.session_id);
    if (existing !== null && existing.n > 0) {
      logger.info("harvest: session already processed", {
        sessionId: params.session_id,
      });
      return { entriesCreated: 0, entriesMerged: 0, entriesSkipped: 0 };
    }
  }

  const cleanedLines = filterNoise(params.transcript);
  const candidates = extractCandidates(cleanedLines);

  let created = 0;
  let merged = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const safeContent = stripSensitiveData(candidate.content);

      if (safeContent.trim().length < 10) {
        skipped += 1;
        continue;
      }

      const safeCandidate: LearnInput = {
        ...candidate,
        content: safeContent,
      };

      const entry = extractEntry(safeCandidate);
      const duplicateId = findDuplicate(db, entry);

      if (duplicateId !== null) {
        db.run(
          `UPDATE entries
           SET source_count   = source_count + 1,
               last_confirmed = ?
           WHERE id = ?`,
          [new Date().toISOString(), duplicateId],
        );

        if (
          params.session_id !== undefined ||
          params.developer_id !== undefined
        ) {
          db.run(
            `INSERT INTO sources (entry_id, developer_id, tool, session_id, timestamp)
             VALUES (?, ?, 'harvest', ?, ?)`,
            [
              duplicateId,
              params.developer_id ?? null,
              params.session_id ?? null,
              new Date().toISOString(),
            ],
          );
        }

        merged += 1;
        continue;
      }

      insertEntry(db, {
        id: entry.id,
        type: entry.type,
        title: entry.title,
        content: entry.content,
        files: entry.files,
        tags: entry.tags,
        errorSignature: entry.errorSignature,
        confidence: entry.confidence,
        sourceCount: 1,
        sourceTool: "harvest",
        createdAt: entry.createdAt,
        lastConfirmed: entry.lastConfirmed,
        status: "active",
        scope: entry.scope,
        developerId: params.developer_id,
      });

      if (
        params.session_id !== undefined ||
        params.developer_id !== undefined
      ) {
        db.run(
          `INSERT INTO sources (entry_id, developer_id, tool, session_id, timestamp)
           VALUES (?, ?, 'harvest', ?, ?)`,
          [
            entry.id,
            params.developer_id ?? null,
            params.session_id ?? null,
            new Date().toISOString(),
          ],
        );
      }

      created += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("harvest: candidate rejected", { error: msg });
      skipped += 1;
    }
  }

  logger.info("harvest: complete", {
    created,
    merged,
    skipped,
    sessionId: params.session_id,
  });

  return { entriesCreated: created, entriesMerged: merged, entriesSkipped: skipped };
}

/**
 * Drops lines that are obviously not human knowledge:
 *   - "System:" prefix lines
 *   - Lines referencing CLAUDE.md (documentation injection artifacts)
 *   - Tool output blocks (from "Tool:" up to the next blank line or turn boundary)
 *   - Pure code output (>= 40 chars with < 20% alphabetic characters)
 *
 * @param transcript - Raw session text.
 * @returns Filtered lines ready for pattern extraction.
 */
function filterNoise(transcript: string): string[] {
  const rawLines = transcript.split("\n");
  const kept: string[] = [];
  let inToolBlock = false;

  for (const line of rawLines) {
    const trimmed = line.trim();

    // Detect start of a tool block
    if (/^Tool:/i.test(trimmed) || /^<tool_/i.test(trimmed)) {
      inToolBlock = true;
    }

    if (inToolBlock) {
      // End of tool block: blank line or conversation turn boundary
      if (
        trimmed === "" ||
        /^(Human|User|Assistant|Claude):/i.test(trimmed)
      ) {
        inToolBlock = false;
        // Fall through so the boundary line itself is evaluated below
      } else {
        continue;
      }
    }

    // Drop system prompt lines
    if (/^System:/i.test(trimmed)) {
      continue;
    }

    // Drop documentation-injection lines
    if (/CLAUDE\.md/i.test(trimmed)) {
      continue;
    }

    // Drop pure code output: long lines dominated by non-alpha characters
    if (trimmed.length >= 40) {
      const alphaCount = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
      const ratio = alphaCount / trimmed.length;
      if (ratio < 0.2) {
        continue;
      }
    }

    kept.push(line);
  }

  return kept;
}

const DECISION_PATTERNS: readonly RegExp[] = [
  /decided to (.{5,150})/i,
  /going with (.{5,150})/i,
  /chose (.{5,100}) because (.{5,100})/i,
  /switching from (.{3,80}) to (.{3,80})/i,
  /instead of (.{3,80}), (?:we(?:'re| are)) using (.{3,80})/i,
];

const ERROR_PATTERNS: readonly RegExp[] = [
  /^error:?\s+(.{5,150})/i,
  /failed:?\s+(.{5,150})/i,
  /the (?:issue|problem|bug) was (.{5,150})/i,
];

const FIX_PATTERNS: readonly RegExp[] = [
  /fix(?:ed)?:?\s+(.{5,150})/i,
  /the fix (?:is|was):?\s+(.{5,150})/i,
  /resolved by (.{5,150})/i,
];

const CONVENTION_PATTERNS: readonly RegExp[] = [
  /always (.{5,150})/i,
  /never (.{5,150})/i,
  /we use (.{5,100}) for (.{5,100})/i,
  /convention:?\s+(.{5,150})/i,
  /standard:?\s+(.{5,150})/i,
  /rule:?\s+(.{5,150})/i,
];

const LEARNING_PATTERNS: readonly RegExp[] = [
  /turns out (.{5,150})/i,
  /learned that (.{5,150})/i,
  /discovered (.{5,150})/i,
  /important:?\s+(.{5,150})/i,
  /note:?\s+(.{5,150})/i,
];

/**
 * Walks filtered lines and emits LearnInput candidates.
 *
 * Error patterns are paired with fix patterns found within a 10-line
 * lookahead window so that a single entry captures both the problem
 * and its resolution.
 *
 * @param lines - Noise-filtered transcript lines.
 * @returns Raw learn inputs ready for the extract/dedupe pipeline.
 */
function extractCandidates(lines: readonly string[]): LearnInput[] {
  const candidates: LearnInput[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // --- Decisions ---
    let matched = false;
    for (const pattern of DECISION_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match !== null) {
        const captured = match.slice(1).filter(Boolean).join(" — ");
        const title = truncateTitle(`Decision: ${captured}`);
        const content = truncateContent(trimmed);
        if (content.length >= 10 && title.length >= 5) {
          candidates.push({
            type: "decision",
            title,
            content,
            files: [],
            tags: [],
          });
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // --- Errors (with fix pairing) ---
    for (const pattern of ERROR_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match !== null) {
        const errorCapture = match[1] ?? trimmed;
        const errorTitle = truncateTitle(`Error: ${errorCapture}`);

        let fixText: string | null = null;
        const lookAheadEnd = Math.min(i + 11, lines.length);
        for (let j = i + 1; j < lookAheadEnd; j++) {
          const futureLine = (lines[j] ?? "").trim();
          for (const fixPattern of FIX_PATTERNS) {
            fixPattern.lastIndex = 0;
            const fixMatch = fixPattern.exec(futureLine);
            if (fixMatch !== null) {
              fixText = futureLine;
              break;
            }
          }
          if (fixText !== null) break;
        }

        const content =
          fixText !== null
            ? truncateContent(`Problem: ${trimmed}\n\nFix: ${fixText}`)
            : truncateContent(trimmed);

        if (content.length >= 10 && errorTitle.length >= 5) {
          candidates.push({
            type: "error_pattern",
            title: errorTitle,
            content,
            files: [],
            tags: [],
            errorMessage: truncateContent(errorCapture),
          });
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // --- Conventions ---
    for (const pattern of CONVENTION_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match !== null) {
        const captured = match.slice(1).filter(Boolean).join(" — ");
        const title = truncateTitle(`Convention: ${captured}`);
        const content = truncateContent(trimmed);
        if (content.length >= 10 && title.length >= 5) {
          candidates.push({
            type: "convention",
            title,
            content,
            files: [],
            tags: [],
          });
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // --- Learnings ---
    for (const pattern of LEARNING_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(trimmed);
      if (match !== null) {
        const captured = match[1] ?? trimmed;
        const title = truncateTitle(`Learning: ${captured}`);
        const content = truncateContent(trimmed);
        if (content.length >= 10 && title.length >= 5) {
          candidates.push({
            type: "learning",
            title,
            content,
            files: [],
            tags: [],
          });
        }
        break;
      }
    }
  }

  return candidates;
}

/**
 * Truncates a string to at most 200 characters.
 */
function truncateTitle(s: string): string {
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}

/**
 * Truncates a string to at most 5000 characters.
 */
function truncateContent(s: string): string {
  return s.length > 5000 ? s.slice(0, 4997) + "..." : s;
}
