/**
 * End-to-end collaboration test for Gyst.
 *
 * Proves that two developers can share knowledge through the system by
 * exercising the full collaboration flow at the database layer — the same
 * layer the HTTP server routes call into.
 *
 * Phases:
 *  1. Team setup    — admin creates team, issues invite, Dev B joins
 *  2. Knowledge sharing — Dev A teaches, Dev B recalls; then roles swap
 *  3. Auth enforcement — invalid / revoked keys are rejected
 *  4. Activity and status — log captures all actions; time-window filtering
 *  5. Deduplication — same error from two developers merges cleanly
 *  6. Latency budgets — in-memory ops well within performance targets
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import type { EntryRow } from "../../src/store/database.js";
import {
  createTeam,
  createInviteKey,
  joinTeam,
  initTeamSchema,
  hashApiKey,
  generateApiKey,
} from "../../src/server/auth.js";
import {
  initActivitySchema,
  logActivity,
  getRecentActivity,
} from "../../src/server/activity.js";
import { getTeamMembers } from "../../src/server/team.js";
import { searchByBM25, reciprocalRankFusion } from "../../src/store/search.js";
import { extractEntry } from "../../src/compiler/extract.js";
import type { LearnInput } from "../../src/compiler/extract.js";
import type { KnowledgeEntry } from "../../src/compiler/extract.js";
import { normalizeErrorSignature, generateFingerprint } from "../../src/compiler/normalize.js";
import { findDuplicate, mergeEntries } from "../../src/compiler/deduplicate.js";

// ---------------------------------------------------------------------------
// Shared state — populated across tests in phase order
// ---------------------------------------------------------------------------

let db: Database;

/** Team provisioned in Phase 1. */
let teamId: string;
let adminKey: string;

/** Dev A's identity (admin, in this scenario). */
const DEV_A_NAME = "Alice";
let devAId: string;

/** Dev B joins via invite key. */
const DEV_B_NAME = "Bob";
let devBId: string;
let devBMemberKey: string;

// ---------------------------------------------------------------------------
// seedDevEntry — simulates what the learn MCP tool does
// ---------------------------------------------------------------------------

/**
 * Extracts, inserts, and logs a single knowledge entry for a developer.
 * Mirrors the learn-tool pipeline: extract → insertEntry → logActivity.
 *
 * @param db          - Open database connection.
 * @param tid         - Team the developer belongs to.
 * @param developerId - Developer performing the learn action.
 * @param input       - Raw learn input (same shape as MCP tool receives).
 * @returns The persisted KnowledgeEntry.
 */
function seedDevEntry(
  db: Database,
  tid: string,
  developerId: string,
  input: LearnInput,
): KnowledgeEntry {
  const entry = extractEntry(input);

  insertEntry(db, {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    files: entry.files,
    tags: entry.tags,
    // errorSignature column stores the normalised signature (not the fingerprint)
    errorSignature: entry.errorSignature,
    confidence: entry.confidence,
    sourceCount: entry.sourceCount,
    sourceTool: entry.sourceTool ?? "mcp-learn",
    createdAt: entry.createdAt,
    lastConfirmed: entry.lastConfirmed,
    status: entry.status,
  });

  logActivity(db, tid, developerId, "learn", entry.id, entry.files);

  return entry;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  db = initDatabase(":memory:");
  initTeamSchema(db);
  initActivitySchema(db);
});

afterAll(() => {
  db.close();
});

// ===========================================================================
// Phase 1: Team setup
// ===========================================================================

describe("Phase 1 — Team setup", () => {
  test("admin creates a team", () => {
    const result = createTeam(db, "Gyst Test Team");

    expect(result.teamId).toBeTruthy();
    expect(result.adminKey).toMatch(/^gyst_admin_[0-9a-f]{32}$/);

    teamId = result.teamId;
    adminKey = result.adminKey;

    // Verify team row exists
    const teamRow = db
      .query<{ id: string; name: string }, [string]>(
        "SELECT id, name FROM teams WHERE id = ?",
      )
      .get(teamId);

    expect(teamRow).not.toBeNull();
    expect(teamRow!.id).toBe(teamId);
    expect(teamRow!.name).toBe("Gyst Test Team");

    // Verify admin API key hash exists
    const keyRow = db
      .query<{ type: string; developer_id: string | null }, [string]>(
        "SELECT type, developer_id FROM api_keys WHERE team_id = ? AND type = 'admin'",
      )
      .get(teamId);

    expect(keyRow).not.toBeNull();
    expect(keyRow!.type).toBe("admin");
    // Admin key has no developer_id yet — it is team-level
    expect(keyRow!.developer_id).toBeNull();
  });

  test("admin creates an invite key", () => {
    const inviteKey = createInviteKey(db, teamId);

    expect(inviteKey).toMatch(/^gyst_invite_[0-9a-f]{32}$/);

    // Verify it exists in api_keys with type='invite' and is not revoked
    const keyRow = db
      .query<{ type: string; revoked: number; expires_at: string }, [string]>(
        "SELECT type, revoked, expires_at FROM api_keys WHERE team_id = ? AND type = 'invite'",
      )
      .get(teamId);

    expect(keyRow).not.toBeNull();
    expect(keyRow!.type).toBe("invite");
    expect(keyRow!.revoked).toBe(0);
    // Invite keys expire after 24 hours — verify expiry is in the future
    expect(new Date(keyRow!.expires_at) > new Date()).toBe(true);
  });

  test("developer B joins the team", async () => {
    // Create a fresh invite key for this test
    const inviteKey = createInviteKey(db, teamId);

    const result = await joinTeam(db, inviteKey, DEV_B_NAME);

    expect(result.developerId).toBeTruthy();
    expect(result.memberKey).toMatch(/^gyst_member_[0-9a-f]{32}$/);

    devBId = result.developerId;
    devBMemberKey = result.memberKey;

    // Verify member record in team_members
    const memberRow = db
      .query<
        { developer_id: string; display_name: string; role: string },
        [string, string]
      >(
        "SELECT developer_id, display_name, role FROM team_members WHERE team_id = ? AND developer_id = ?",
      )
      .get(teamId, devBId);

    expect(memberRow).not.toBeNull();
    expect(memberRow!.developer_id).toBe(devBId);
    expect(memberRow!.display_name).toBe(DEV_B_NAME);
    expect(memberRow!.role).toBe("member");

    // At least one invite key was consumed — check by verifying the member key row
    const memberKeyRow = db
      .query<{ type: string; revoked: number }, [string, string]>(
        "SELECT type, revoked FROM api_keys WHERE team_id = ? AND developer_id = ?",
      )
      .get(teamId, devBId);

    expect(memberKeyRow).not.toBeNull();
    expect(memberKeyRow!.type).toBe("member");
    expect(memberKeyRow!.revoked).toBe(0);

    // Verify the invite key that was just used is revoked
    const usedInviteRows = db
      .query<{ revoked: number }, []>(
        "SELECT revoked FROM api_keys WHERE team_id = ? AND type = 'invite' AND revoked = 1",
      )
      // bind parameters manually since bun:sqlite query() needs them in .all()
      .all();

    // There should be at least one revoked invite key for the team
    const revokedInvites = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM api_keys WHERE team_id = ? AND type = 'invite' AND revoked = 1",
      )
      .get(teamId);

    expect(revokedInvites!.count).toBeGreaterThanOrEqual(1);
  });

  test("team has two members", () => {
    // Seed Dev A as the admin member in team_members
    // (createTeam provisions the API key but not a team_members row —
    //  we insert one here to represent Alice as the admin developer)
    const now = new Date().toISOString();
    devAId = crypto.randomUUID();

    const adminKeyHash = Bun.password.hashSync(adminKey, {
      algorithm: "bcrypt",
      cost: 10,
    });

    db.run(
      `INSERT OR IGNORE INTO team_members
         (team_id, developer_id, display_name, api_key_hash, role, joined_at)
       VALUES (?, ?, ?, ?, 'admin', ?)`,
      [teamId, devAId, DEV_A_NAME, adminKeyHash, now],
    );

    const members = getTeamMembers(db, teamId);

    expect(members.length).toBe(2);

    const names = members.map((m) => m.displayName);
    expect(names).toContain(DEV_A_NAME);
    expect(names).toContain(DEV_B_NAME);

    const roles = members.map((m) => m.role);
    expect(roles).toContain("admin");
    expect(roles).toContain("member");
  });
});

// ===========================================================================
// Phase 2: Knowledge sharing
// ===========================================================================

/** IDs of entries seeded during Phase 2, used in later assertions. */
let devAErrorEntryId: string;
let devAConventionEntryId: string;
let devBEntryId: string;

describe("Phase 2 — Knowledge sharing", () => {
  test("Dev A learns an error pattern", () => {
    const entry = seedDevEntry(db, teamId, devAId, {
      type: "error_pattern",
      title: "Cannot read properties of undefined (reading map)",
      content:
        "Occurs when iterating over an async-loaded array before the data arrives. " +
        "Guard with `Array.isArray(data) && data.map(...)` or optional chaining.",
      files: ["src/components/DataTable.tsx"],
      tags: ["react", "async", "undefined"],
      errorType: "TypeError",
      errorMessage: "Cannot read properties of undefined (reading 'map')",
      sourceTool: "mcp-learn",
    });

    devAErrorEntryId = entry.id;

    // Verify entry exists in the database
    const row = db
      .query<{ id: string; type: string }, [string]>(
        "SELECT id, type FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row).not.toBeNull();
    expect(row!.id).toBe(entry.id);
    expect(row!.type).toBe("error_pattern");
  });

  test("Dev A learns a convention", () => {
    const entry = seedDevEntry(db, teamId, devAId, {
      type: "convention",
      title: "Always use React Query for server state",
      content:
        "All data fetched from the API must go through React Query. " +
        "Never use raw useEffect + useState for data fetching — it leads to " +
        "race conditions and stale closure bugs.",
      files: ["src/hooks/useData.ts"],
      tags: ["react-query", "conventions", "data-fetching"],
      sourceTool: "mcp-learn",
    });

    devAConventionEntryId = entry.id;

    const row = db
      .query<{ id: string; type: string }, [string]>(
        "SELECT id, type FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row).not.toBeNull();
    expect(row!.type).toBe("convention");
  });

  test("Dev B can recall Dev A's knowledge", () => {
    // Dev B searches for the error pattern Dev A recorded.
    // This simulates the recall MCP tool's BM25 + RRF search path.
    // Use terms that appear in the stored title/content — not just tags.
    const bm25Results = searchByBM25(db, "cannot read properties undefined map async array");
    const fused = reciprocalRankFusion([bm25Results]);

    logActivity(db, teamId, devBId, "recall", undefined, []);

    // Dev A's entry must appear in the results
    const resultIds = fused.map((r) => r.id);
    expect(resultIds).toContain(devAErrorEntryId);

    // Verify the top result is Dev A's entry
    expect(fused[0].id).toBe(devAErrorEntryId);
  });

  test("Dev B sees Dev A's activity", () => {
    // Dev B queries recent team activity — should see Dev A's learn actions
    const activity = getRecentActivity(db, teamId, 1);

    const devAActions = activity.filter((a) => a.developerId === devAId);
    expect(devAActions.length).toBeGreaterThanOrEqual(2); // error + convention

    const actions = devAActions.map((a) => a.action);
    expect(actions).toContain("learn");

    const entryIds = devAActions.map((a) => a.entryId);
    expect(entryIds).toContain(devAErrorEntryId);
    expect(entryIds).toContain(devAConventionEntryId);
  });

  test("Dev B learns something new", () => {
    const entry = seedDevEntry(db, teamId, devBId, {
      type: "convention",
      title: "Prefer zod for all API boundary validation",
      content:
        "Every value crossing an API boundary — request bodies, response payloads, " +
        "env vars — must be validated with a Zod schema. This prevents runtime surprises " +
        "and gives TypeScript accurate inferred types.",
      files: ["src/api/validators.ts"],
      tags: ["zod", "validation", "conventions"],
      sourceTool: "mcp-learn",
    });

    devBEntryId = entry.id;

    const row = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE id = ?",
      )
      .get(entry.id);

    expect(row).not.toBeNull();
  });

  test("Dev A can recall Dev B's knowledge", () => {
    // Dev A searches for what Dev B recorded about Zod
    const bm25Results = searchByBM25(db, "zod validation API boundary schema");
    const fused = reciprocalRankFusion([bm25Results]);

    logActivity(db, teamId, devAId, "recall", undefined, []);

    const resultIds = fused.map((r) => r.id);
    expect(resultIds).toContain(devBEntryId);
  });
});

// ===========================================================================
// Phase 3: Auth enforcement
// ===========================================================================

describe("Phase 3 — Auth enforcement", () => {
  test("invalid API key is rejected", async () => {
    const fakeKey = generateApiKey("member");

    // Load all hashes from the database and verify none match the fake key
    const rows = db
      .query<{ key_hash: string }, []>(
        "SELECT key_hash FROM api_keys WHERE revoked = 0",
      )
      .all();

    let matched = false;
    for (const row of rows) {
      const ok = await Bun.password.verify(fakeKey, row.key_hash);
      if (ok) {
        matched = true;
        break;
      }
    }

    expect(matched).toBe(false);
  });

  test("revoked key cannot authenticate", async () => {
    // Create a new invite key, then immediately revoke it
    const inviteKey = createInviteKey(db, teamId);

    // Find the newly created invite row (most recent, unrevoked)
    const keyRow = db
      .query<{ key_hash: string }, [string]>(
        `SELECT key_hash FROM api_keys
         WHERE  team_id = ? AND type = 'invite' AND revoked = 0
         ORDER  BY created_at DESC LIMIT 1`,
      )
      .get(teamId);

    expect(keyRow).not.toBeNull();

    // Revoke it directly
    db.run("UPDATE api_keys SET revoked = 1 WHERE key_hash = ?", [keyRow!.key_hash]);

    // Attempt to use the revoked invite key to join
    let errorThrown = false;
    try {
      await joinTeam(db, inviteKey, "Mallory");
    } catch (err) {
      errorThrown = true;
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("Invalid or already-used invite key");
    }

    expect(errorThrown).toBe(true);
  });
});

// ===========================================================================
// Phase 4: Activity and status
// ===========================================================================

describe("Phase 4 — Activity and status", () => {
  test("activity log captures all actions from both developers", () => {
    const activity = getRecentActivity(db, teamId, 1);

    // Both developers appear in the log
    const developerIds = new Set(activity.map((a) => a.developerId));
    expect(developerIds.has(devAId)).toBe(true);
    expect(developerIds.has(devBId)).toBe(true);

    // There are learn entries for both
    const devALearn = activity.filter(
      (a) => a.developerId === devAId && a.action === "learn",
    );
    const devBLearn = activity.filter(
      (a) => a.developerId === devBId && a.action === "learn",
    );

    expect(devALearn.length).toBeGreaterThanOrEqual(2);
    expect(devBLearn.length).toBeGreaterThanOrEqual(1);

    // Recall actions are logged too
    const recallActions = activity.filter((a) => a.action === "recall");
    expect(recallActions.length).toBeGreaterThanOrEqual(2); // one each from Dev A & B

    // All entries have valid timestamps
    for (const entry of activity) {
      expect(entry.timestamp).toBeTruthy();
      expect(new Date(entry.timestamp).getFullYear()).toBeGreaterThan(2020);
    }

    // Each learn action for error/convention entries has an entryId
    const learnActions = activity.filter((a) => a.action === "learn");
    for (const la of learnActions) {
      expect(la.entryId).not.toBeNull();
    }
  });

  test("recent activity filters by time window and is newest-first", () => {
    // hours=1 should return everything created moments ago
    const recent = getRecentActivity(db, teamId, 1);
    expect(recent.length).toBeGreaterThan(0);

    // Verify descending order (newest first)
    for (let i = 0; i < recent.length - 1; i++) {
      expect(recent[i].timestamp >= recent[i + 1].timestamp).toBe(true);
    }

    // hours=0 should return nothing (cutoff is now, nothing is in the future)
    const zero = getRecentActivity(db, teamId, 0);
    expect(zero.length).toBe(0);
  });

  test("excludeDeveloperId filters out a specific developer's activity", () => {
    // Dev B queries activity excluding themselves — should only see Dev A's actions
    const activity = getRecentActivity(db, teamId, 1, devBId);

    const devBEntries = activity.filter((a) => a.developerId === devBId);
    expect(devBEntries.length).toBe(0);

    // Dev A's entries are still present
    const devAEntries = activity.filter((a) => a.developerId === devAId);
    expect(devAEntries.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Phase 5: Knowledge deduplication across team
// ===========================================================================

describe("Phase 5 — Knowledge deduplication across team", () => {
  test("same error from two developers produces the same normalised signature", () => {
    // Dev A encounters the error on their machine — message includes a UUID and line number
    const devAMessage =
      "Cannot read properties of undefined (reading 'filter') at /home/alice/project/src/api/handler.ts:47:12";

    // Dev B encounters the same logical error but with different path and line numbers
    const devBMessage =
      "Cannot read properties of undefined (reading 'filter') at /Users/bob/workspace/gyst/src/api/handler.ts:103:5";

    const devASig = normalizeErrorSignature(devAMessage);
    const devBSig = normalizeErrorSignature(devBMessage);

    // Volatile tokens (paths, line numbers) have been replaced with placeholders
    expect(devASig).toBe(devBSig);

    // Both fingerprints, given the same errorType, are identical
    const devAFp = generateFingerprint("TypeError", devASig);
    const devBFp = generateFingerprint("TypeError", devBSig);

    expect(devAFp).toBe(devBFp);
    expect(devAFp).toHaveLength(16);
  });

  test("same error from two developers merges via findDuplicate + mergeEntries", () => {
    const sharedError = {
      type: "TypeError" as const,
      message: "Cannot read properties of null (reading 'value') at src/form/Input.tsx:22:8",
    };

    const devAInput: LearnInput = {
      type: "error_pattern",
      title: "Cannot read null value in Input component",
      content:
        "The Input component's ref is null on first render. " +
        "Guard with `if (inputRef.current) { ... }` before accessing `.value`.",
      files: ["src/form/Input.tsx"],
      tags: ["refs", "null-check", "react"],
      errorType: sharedError.type,
      errorMessage: sharedError.message,
      sourceTool: "mcp-learn",
    };

    const devBInput: LearnInput = {
      type: "error_pattern",
      title: "Null ref access in form Input — add null guard",
      content:
        "Accessing `.value` on a React ref before mount throws. " +
        "Fix: check `inputRef.current !== null` before reading the value.",
      files: ["src/form/Input.tsx"],
      tags: ["refs", "null-check", "react"],
      errorType: sharedError.type,
      errorMessage: sharedError.message,
      sourceTool: "mcp-learn",
    };

    // Dev A learns first
    const entryA = extractEntry(devAInput);
    insertEntry(db, {
      id: entryA.id,
      type: entryA.type,
      title: entryA.title,
      content: entryA.content,
      files: entryA.files,
      tags: entryA.tags,
      errorSignature: entryA.errorSignature,
      confidence: entryA.confidence,
      sourceCount: entryA.sourceCount,
      sourceTool: entryA.sourceTool,
      createdAt: entryA.createdAt,
      lastConfirmed: entryA.lastConfirmed,
      status: entryA.status,
    });
    logActivity(db, teamId, devAId, "learn", entryA.id, entryA.files);

    // Dev B encounters the same error — findDuplicate detects it
    const entryB = extractEntry(devBInput);

    const duplicateId = findDuplicate(db, entryB);
    expect(duplicateId).not.toBeNull();
    expect(duplicateId).toBe(entryA.id);

    // Merge Dev B's insight into the existing entry
    const existingRow = db
      .query<EntryRow & { source_count: number; error_signature: string | null }, [string]>(
        `SELECT id, type, title, content, confidence, source_count, status,
                COALESCE(created_at, datetime('now')) AS createdAt,
                COALESCE(last_confirmed, datetime('now')) AS lastConfirmed
         FROM entries WHERE id = ?`,
      )
      .get(entryA.id);

    expect(existingRow).not.toBeNull();

    // Reconstruct KnowledgeEntry shape for mergeEntries
    const existingEntry: KnowledgeEntry = {
      id: entryA.id,
      type: entryA.type,
      title: entryA.title,
      content: entryA.content,
      files: [...entryA.files],
      tags: [...entryA.tags],
      errorSignature: entryA.errorSignature,
      fingerprint: entryA.fingerprint,
      confidence: entryA.confidence,
      sourceCount: entryA.sourceCount,
      sourceTool: entryA.sourceTool,
      createdAt: entryA.createdAt,
      lastConfirmed: entryA.lastConfirmed,
      status: entryA.status,
    };

    const merged = mergeEntries(existingEntry, entryB);

    // Verify the merge result
    expect(merged.id).toBe(entryA.id);
    expect(merged.sourceCount).toBe(2); // 1 (Dev A) + 1 (Dev B)
    expect(merged.confidence).toBeGreaterThanOrEqual(entryA.confidence);

    // Tags and files are unioned — both devs share the same files/tags here
    expect(merged.files).toContain("src/form/Input.tsx");
    expect(merged.tags).toContain("refs");
    expect(merged.tags).toContain("null-check");
    expect(merged.tags).toContain("react");

    // Persist the merged entry by updating in place
    db.run(
      `UPDATE entries
       SET source_count = ?, confidence = ?, last_confirmed = ?, content = ?
       WHERE id = ?`,
      [merged.sourceCount, merged.confidence, merged.lastConfirmed ?? new Date().toISOString(), merged.content, merged.id],
    );

    const updatedRow = db
      .query<{ source_count: number }, [string]>(
        "SELECT source_count FROM entries WHERE id = ?",
      )
      .get(entryA.id);

    expect(updatedRow!.source_count).toBe(2);
  });
});

// ===========================================================================
// Phase 6: Latency measurements
// ===========================================================================

describe("Phase 6 — Performance budgets", () => {
  test("insertEntry completes within 200ms", () => {
    const start = performance.now();

    insertEntry(db, {
      id: crypto.randomUUID(),
      type: "learning",
      title: "Performance budget test entry",
      content:
        "This entry is inserted to measure insertEntry latency on in-memory SQLite.",
      files: ["src/utils/perf.ts"],
      tags: ["perf", "test"],
      confidence: 0.9,
      sourceCount: 1,
      sourceTool: "perf-test",
    });

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  test("searchByBM25 completes within 500ms", () => {
    const start = performance.now();

    // Use terms present in the seeded entries' title/content
    const results = searchByBM25(db, "cannot read properties undefined");

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Sanity check — we expect at least one result given earlier seeded data
    expect(results.length).toBeGreaterThan(0);
  });

  test("reciprocalRankFusion completes within 100ms", () => {
    // Use terms present in Dev B's seeded convention entry
    const bm25 = searchByBM25(db, "zod schema validation API boundary");

    const start = performance.now();
    const fused = reciprocalRankFusion([bm25]);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(fused.length).toBeGreaterThan(0);
  });

  test("getRecentActivity query completes within 100ms", () => {
    const start = performance.now();

    const activity = getRecentActivity(db, teamId, 24);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(activity.length).toBeGreaterThan(0);
  });

  test("hashApiKey (bcrypt cost=10) completes within 2000ms", async () => {
    const key = generateApiKey("test");

    const start = performance.now();
    const hash = await hashApiKey(key);
    const elapsed = performance.now() - start;

    expect(hash).toBeTruthy();
    expect(hash.startsWith("$2")).toBe(true); // bcrypt prefix
    // bcrypt with cost=10 is intentionally slow — 2 s budget is generous
    expect(elapsed).toBeLessThan(2000);
  });
});
