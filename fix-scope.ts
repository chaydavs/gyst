/**
 * fix-scope.ts — promote personal entries to team scope so recall can find them.
 *
 * Run from the gyst folder:
 *   bun run fix-scope.ts
 *
 * Safe to run multiple times.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const paths = [
  "../.gyst/wiki.db",
  ".gyst/wiki.db",
];

let totalFixed = 0;

for (const path of paths) {
  if (!existsSync(path)) {
    console.log(`skip: ${path} (not found)`);
    continue;
  }

  try {
    const db = new Database(path);
    const before = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM entries WHERE scope='personal'",
    ).get();
    const count = before?.n ?? 0;

    db.run("UPDATE entries SET scope='team' WHERE scope='personal'");

    const totalEntries = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM entries",
    ).get()?.n ?? 0;

    console.log(
      `ok:   ${path} — promoted ${count} personal -> team (${totalEntries} total)`,
    );
    totalFixed += count;
    db.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`err:  ${path} — ${msg}`);
  }
}

console.log("");
console.log(`Done. ${totalFixed} entries promoted.`);
