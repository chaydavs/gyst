/**
 * Stage 2 Distillation Logic.
 *
 * Takes "completed" events from the event_queue (those already processed by
 * Stage 1 rule-based classification) and uses an LLM to extract deeper, 
 * more nuanced knowledge.
 *
 * This stage is crucial for capturing "ghost knowledge" that doesn't follow
 * standard phrasing or patterns but is clearly evident in the stream of
 * developer-agent interactions.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { distillWithLlm, type LlmResponse } from "../utils/llm.js";

export interface DistillOptions {
  readonly limit?: number;
  readonly sessionId?: string;
}

export interface DistillReport {
  readonly sessionsProcessed: number;
  readonly eventsProcessed: number;
  readonly entriesCreated: number;
}

/**
 * Distills knowledge from completed events.
 */
export async function distillEvents(
  db: Database,
  options: DistillOptions = {},
): Promise<DistillReport> {
  const limit = options.limit ?? 100;
  
  // 1. Fetch completed events that haven't been distilled yet.
  // We use the status 'completed' from Stage 1 as the starting point.
  // To avoid double-distilling, we'll mark them as 'distilled' or use a 
  // secondary check. For Phase 2, we'll select completed events and 
  // mark them as distilled in the metadata or a new status.
  
  let query = `
    SELECT id, type, payload, session_id 
    FROM event_queue 
    WHERE status = 'completed'
  `;
  const params: any[] = [];

  if (options.sessionId) {
    query += " AND session_id = ?";
    params.push(options.sessionId);
  }

  query += " ORDER BY id ASC LIMIT ?";
  params.push(limit);

  const rows = db.query<{ id: number; type: string; payload: string; session_id: string | null }, any[]>(query).all(...params);

  if (rows.length === 0) {
    return { sessionsProcessed: 0, eventsProcessed: 0, entriesCreated: 0 };
  }

  // 2. Group events by session_id
  const sessionGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    const sid = row.session_id ?? "orphan";
    if (!sessionGroups.has(sid)) sessionGroups.set(sid, []);
    sessionGroups.get(sid)!.push(row);
  }

  let entriesCreated = 0;
  let eventsProcessed = 0;

  // 3. Process each session group with the LLM
  for (const [sid, sessionRows] of sessionGroups.entries()) {
    try {
      const prompt = constructDistillationPrompt(sid, sessionRows);
      const result = await distillWithLlm(prompt);

      for (const entry of result.entries) {
        createEntryFromDistillation(db, entry, sid);
        entriesCreated++;
      }

      // Mark these events as distilled to avoid re-processing
      const ids = sessionRows.map(r => r.id);
      db.run(
        `UPDATE event_queue SET status = 'completed', error = 'distilled' WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
      
      eventsProcessed += sessionRows.length;
    } catch (err) {
      logger.error("distill: session failed", { sessionId: sid, error: String(err) });
    }
  }

  return {
    sessionsProcessed: sessionGroups.size,
    eventsProcessed,
    entriesCreated,
  };
}

function constructDistillationPrompt(sessionId: string, rows: { type: string; payload: string }[]): string {
  const eventsMarkdown = rows.map((r, i) => {
    const p = JSON.parse(r.payload);
    return `### Event ${i+1}: ${r.type}\n\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``;
  }).join("\n\n");

  return `
Analyze the following stream of developer-agent interaction events from session "${sessionId}".
Extract any durable team knowledge, conventions, decisions, or recurring error patterns.

Ignore trivial interactions (e.g., "ok", "thanks"). 
Focus on:
- Coding standards mentioned or enforced.
- Architectural decisions made.
- Complex bugs and their root causes.
- Environmental or tool-specific quirks discovered.

Return a JSON object with an "entries" array. Each entry must follow this schema:
{
  "type": "convention" | "decision" | "learning" | "error_pattern",
  "title": "Concise, descriptive title",
  "content": "Detailed explanation of the knowledge captured",
  "confidence": 0.0 to 1.0,
  "scope": "personal" | "team",
  "tags": ["tag1", "tag2"],
  "file_paths": ["src/relevant/file.ts"]
}

---
EVENTS:
${eventsMarkdown}
`;
}

function createEntryFromDistillation(
  db: Database, 
  entry: LlmResponse["entries"][0],
  sessionId: string
): void {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.run(
      `INSERT INTO entries
         (id, type, title, content, confidence, source_count, source_tool,
          created_at, last_confirmed, status, scope)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?)`,
      [
        id,
        entry.type,
        entry.title,
        entry.content,
        entry.confidence,
        `distiller:session:${sessionId}`,
        now,
        now,
        entry.scope,
      ],
    );

    if (entry.file_paths) {
      for (const path of entry.file_paths) {
        db.run("INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)", [id, path]);
      }
    }

    if (entry.tags) {
      for (const tag of entry.tags) {
        db.run("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)", [id, tag]);
      }
    }
  })();
}
