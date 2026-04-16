import type { Database } from "bun:sqlite";

export interface RecapOptions {
  readonly sinceMinutes?: number;
}

export function renderRecap(db: Database, options: RecapOptions = {}): string {
  const minutes = options.sinceMinutes ?? 60;
  const cutoff = `-${minutes} minutes`;

  const counts = db
    .query<{type: string, c: number}, [string]>(
      "SELECT type, COUNT(*) AS c FROM event_queue WHERE created_at >= datetime('now', ?) GROUP BY type",
    )
    .all(cutoff);

  const countOf = (t: string): number => counts.find((r) => r.type === t)?.c ?? 0;

  const entries = db
    .query<{id: string, type: string, title: string}, [string]>(
      "SELECT id, type, title FROM entries WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC",
    )
    .all(cutoff);

  const lines: string[] = [];
  lines.push("# Session recap");
  lines.push("");
  lines.push(`Window: last ${minutes} minutes`);
  lines.push("");
  lines.push(`Prompts: ${countOf("prompt")}`);
  lines.push(`Tool calls: ${countOf("tool_use")}`);
  lines.push(`Commits: ${countOf("commit")}`);
  lines.push(`Pulls: ${countOf("pull")}`);
  lines.push("");

  if (entries.length === 0 && counts.length === 0) {
    lines.push("_no activity in this window_");
  } else if (entries.length > 0) {
    lines.push("## New entries");
    for (const e of entries) {
      lines.push(`- (${e.type}) ${e.title}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
