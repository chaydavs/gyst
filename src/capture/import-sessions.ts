/**
 * Session importer for Gyst.
 *
 * Reads transcripts from other coding-assistant tools and feeds each one
 * through the `harvestTranscript` pipeline. This lets a developer seed
 * their knowledge base with months of historical Claude Code / Cursor
 * conversations in a single command, without having to re-run any of
 * those sessions.
 *
 * Every imported session is keyed by a stable `session_id` so
 * re-importing the same folder is a no-op (handled inside
 * `harvestTranscript`).
 *
 * Supported sources:
 *   - `claude-code` : `~/.claude/projects/<slug>/*.jsonl`
 *   - `cursor`      : Cursor's `state.vscdb` (SQLite) under the platform
 *                     `globalStorage` path. Falls back to `--path` if
 *                     the default isn't reachable.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { harvestTranscript } from "../mcp/tools/harvest.js";
import { cwdToSlug } from "../cli/harvest.js";
import { logger } from "../utils/logger.js";

/** Cap per session file so a runaway transcript can't blow out memory
 *  or trip the 100KB harvest input limit. */
const MAX_SESSION_BYTES = 100_000;

export type ImportSource = "claude-code" | "cursor";

export interface ImportOptions {
  /** Optional explicit path override. */
  readonly path?: string;
  /** Import sessions for every project, not just the current cwd. */
  readonly allProjects?: boolean;
  /** Hard cap on sessions to ingest. Default: 100. */
  readonly max?: number;
}

export interface ImportReport {
  readonly source: ImportSource;
  readonly sessionsFound: number;
  readonly sessionsImported: number;
  readonly entriesCreated: number;
  readonly entriesMerged: number;
  readonly entriesSkipped: number;
  readonly failures: number;
}

/**
 * Entry point called by the CLI. Dispatches to the per-source importer
 * and aggregates a single report.
 */
export async function importSessions(
  db: Database,
  source: ImportSource,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  if (source === "claude-code") return importClaudeCode(db, opts);
  if (source === "cursor") return importCursor(db, opts);
  throw new Error(`Unknown import source: ${source}`);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Walks `~/.claude/projects/<slug>/*.jsonl` for the current project (or
 * every project when `allProjects` is set), flattens each JSONL into a
 * plain-text transcript, and runs it through `harvestTranscript`.
 */
function importClaudeCode(
  db: Database,
  opts: ImportOptions,
): ImportReport {
  const root = opts.path ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) {
    logger.warn("import: claude-code projects dir missing", { root });
    return emptyReport("claude-code");
  }

  const projectDirs = opts.allProjects
    ? listDirectories(root)
    : [join(root, cwdToSlug(process.cwd()))].filter(existsSync);

  const files: string[] = [];
  for (const dir of projectDirs) {
    for (const f of listFiles(dir)) {
      if (f.endsWith(".jsonl")) files.push(f);
    }
  }

  const limited = files.slice(0, opts.max ?? 100);
  return ingestTranscripts("claude-code", db, limited, claudeJsonlToTranscript);
}

/**
 * Flattens a Claude Code JSONL session file into a plain-text transcript
 * the harvest pipeline can scan. Only message events with text content
 * contribute — tool calls and queue events are skipped to keep the
 * transcript under the 100KB limit.
 */
function claudeJsonlToTranscript(path: string): string {
  const raw = readFileSync(path, "utf-8");
  const parts: string[] = [];
  let bytes = 0;

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    const obj = rec as Record<string, unknown>;

    // Only keep user / assistant message turns.
    const kind = typeof obj["type"] === "string" ? (obj["type"] as string) : "";
    if (kind !== "user" && kind !== "assistant") continue;

    const role = kind === "user" ? "Human" : "Assistant";
    const text = extractClaudeMessageText(obj);
    if (text.length === 0) continue;

    const chunk = `${role}: ${text}\n`;
    bytes += Buffer.byteLength(chunk, "utf-8");
    if (bytes > MAX_SESSION_BYTES) break;
    parts.push(chunk);
  }

  return parts.join("\n");
}

/**
 * Pulls text out of the nested `message.content[]` structure Claude Code
 * writes. Handles both the string-content shape (rare, older sessions)
 * and the array-of-blocks shape (every modern session).
 */
function extractClaudeMessageText(rec: Record<string, unknown>): string {
  const msg = rec["message"];
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as Record<string, unknown>)["content"];
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const buf: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      buf.push(b["text"]);
    }
  }
  return buf.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * Reads Cursor's `state.vscdb` (a plain SQLite file) and emits one
 * transcript per stored chat or composer conversation. The keys Cursor
 * uses have shifted between versions, so we scan the `ItemTable` for any
 * key that looks like chat / composer data and parse the JSON value.
 */
function importCursor(db: Database, opts: ImportOptions): ImportReport {
  const vscdb = opts.path ?? defaultCursorDbPath();
  if (!vscdb || !existsSync(vscdb)) {
    logger.warn("import: cursor state.vscdb missing", { path: vscdb });
    return emptyReport("cursor");
  }

  let cursorDb: Database;
  try {
    // Open read-only to avoid fighting a running Cursor instance for the
    // write lock. Bun's SQLite driver accepts the URI style.
    cursorDb = new Database(vscdb, { readonly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("import: cannot open cursor db", { path: vscdb, error: msg });
    return emptyReport("cursor");
  }

  const conversations: { id: string; transcript: string }[] = [];
  try {
    const rows = cursorDb
      .query<{ key: string; value: string }, []>(
        `SELECT key, value FROM ItemTable
         WHERE key LIKE '%aichat%'
            OR key LIKE '%composer%'
            OR key LIKE '%aiService%'`,
      )
      .all();

    for (const row of rows) {
      const extracted = cursorValueToConversations(row.key, row.value);
      for (const c of extracted) conversations.push(c);
    }
  } finally {
    cursorDb.close();
  }

  const limited = conversations.slice(0, opts.max ?? 100);
  return ingestInMemory("cursor", db, limited);
}

/**
 * Parses one row from Cursor's `ItemTable` into zero or more
 * `(id, transcript)` pairs. Cursor versions store their data under
 * slightly different shapes; this handles the two common forms:
 *   - `{ tabs: [{ bubbles: [...] }] }`  (older chat panel)
 *   - `{ allComposers: [{ text, ... }] }` / `{ conversations: [...] }`
 */
function cursorValueToConversations(
  key: string,
  value: string,
): { id: string; transcript: string }[] {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];

  const out: { id: string; transcript: string }[] = [];
  const root = json as Record<string, unknown>;

  // Shape 1: `tabs[].bubbles[]`
  const tabs = root["tabs"];
  if (Array.isArray(tabs)) {
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (typeof tab !== "object" || tab === null) continue;
      const bubbles = (tab as Record<string, unknown>)["bubbles"];
      if (!Array.isArray(bubbles)) continue;
      const transcript = bubblesToTranscript(bubbles);
      if (transcript.length > 0) {
        out.push({ id: `${key}#tab-${i}`, transcript });
      }
    }
  }

  // Shape 2: `allComposers[]`
  const composers = root["allComposers"];
  if (Array.isArray(composers)) {
    for (let i = 0; i < composers.length; i++) {
      const c = composers[i];
      if (typeof c !== "object" || c === null) continue;
      const text = (c as Record<string, unknown>)["text"];
      const composerId =
        typeof (c as Record<string, unknown>)["composerId"] === "string"
          ? ((c as Record<string, unknown>)["composerId"] as string)
          : `${key}#composer-${i}`;
      if (typeof text === "string" && text.trim().length > 0) {
        out.push({ id: composerId, transcript: text });
      }
    }
  }

  // Shape 3: `conversations[]`
  const convs = root["conversations"];
  if (Array.isArray(convs)) {
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i];
      if (typeof c !== "object" || c === null) continue;
      const messages = (c as Record<string, unknown>)["messages"];
      if (!Array.isArray(messages)) continue;
      const transcript = bubblesToTranscript(messages);
      if (transcript.length > 0) {
        out.push({ id: `${key}#conv-${i}`, transcript });
      }
    }
  }

  return out;
}

/**
 * Flattens an array of message bubbles into a transcript the harvest
 * pipeline recognises ("Human:" / "Assistant:" turn prefixes).
 */
function bubblesToTranscript(bubbles: readonly unknown[]): string {
  const parts: string[] = [];
  let bytes = 0;
  for (const b of bubbles) {
    if (typeof b !== "object" || b === null) continue;
    const obj = b as Record<string, unknown>;

    const text = pickFirstString(obj, ["text", "content", "message", "richText"]);
    if (!text) continue;

    const rawRole = pickFirstString(obj, ["role", "type"]) ?? "";
    const role =
      rawRole.toLowerCase().includes("user") ||
      rawRole.toLowerCase().includes("human")
        ? "Human"
        : "Assistant";

    const chunk = `${role}: ${text}\n`;
    bytes += Buffer.byteLength(chunk, "utf-8");
    if (bytes > MAX_SESSION_BYTES) break;
    parts.push(chunk);
  }
  return parts.join("\n");
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** Platform-specific default location of Cursor's state.vscdb. */
function defaultCursorDbPath(): string | null {
  const p = platform();
  if (p === "win32") {
    const appdata = process.env["APPDATA"];
    if (!appdata) return null;
    return join(appdata, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (p === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  // Linux / *BSD
  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

// ---------------------------------------------------------------------------
// Shared ingestion
// ---------------------------------------------------------------------------

function ingestTranscripts(
  source: ImportSource,
  db: Database,
  files: readonly string[],
  toTranscript: (path: string) => string,
): ImportReport {
  let sessionsImported = 0;
  let entriesCreated = 0;
  let entriesMerged = 0;
  let entriesSkipped = 0;
  let failures = 0;

  for (const file of files) {
    try {
      const transcript = toTranscript(file);
      if (transcript.trim().length === 0) continue;

      const result = harvestTranscript(db, {
        transcript,
        session_id: `${source}:${file}`,
      });
      sessionsImported += 1;
      entriesCreated += result.entriesCreated;
      entriesMerged += result.entriesMerged;
      entriesSkipped += result.entriesSkipped;
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("import: session failed", { source, file, error: msg });
    }
  }

  return {
    source,
    sessionsFound: files.length,
    sessionsImported,
    entriesCreated,
    entriesMerged,
    entriesSkipped,
    failures,
  };
}

function ingestInMemory(
  source: ImportSource,
  db: Database,
  conversations: readonly { id: string; transcript: string }[],
): ImportReport {
  let sessionsImported = 0;
  let entriesCreated = 0;
  let entriesMerged = 0;
  let entriesSkipped = 0;
  let failures = 0;

  for (const c of conversations) {
    try {
      if (c.transcript.trim().length === 0) continue;
      const result = harvestTranscript(db, {
        transcript:
          c.transcript.length > MAX_SESSION_BYTES
            ? c.transcript.slice(0, MAX_SESSION_BYTES)
            : c.transcript,
        session_id: `${source}:${c.id}`,
      });
      sessionsImported += 1;
      entriesCreated += result.entriesCreated;
      entriesMerged += result.entriesMerged;
      entriesSkipped += result.entriesSkipped;
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("import: conversation failed", { source, id: c.id, error: msg });
    }
  }

  return {
    source,
    sessionsFound: conversations.length,
    sessionsImported,
    entriesCreated,
    entriesMerged,
    entriesSkipped,
    failures,
  };
}

function listDirectories(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function emptyReport(source: ImportSource): ImportReport {
  return {
    source,
    sessionsFound: 0,
    sessionsImported: 0,
    entriesCreated: 0,
    entriesMerged: 0,
    entriesSkipped: 0,
    failures: 0,
  };
}
