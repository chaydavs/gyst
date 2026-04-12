/**
 * Collaborative knowledge-flow tests for Gyst.
 *
 * Proves that team-shared knowledge actually helps developer agents — not
 * just "can you find the entry" but "does the team get smarter over time."
 *
 * Four suites:
 *   1. Error propagation  — Dev A teaches, Dev B benefits
 *   2. Convention sharing — new coding conventions spread across the team
 *   3. Ghost knowledge    — org-wide truths reach every developer
 *   4. Personal scope     — personal entries are invisible to other devs
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../../src/store/database.js";
import { searchByBM25, searchByFilePath } from "../../src/store/search.js";
import {
  initTeamSchema,
  createTeam,
  createInviteKey,
  joinTeam,
} from "../../src/server/auth.js";
import {
  initActivitySchema,
  logActivity,
  getRecentActivity,
} from "../../src/server/activity.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extract just the IDs from a RankedResult array for readable assertions. */
function ids(results: { id: string }[]): string[] {
  return results.map((r) => r.id);
}

/** Returns true when `needle` appears within the first `topN` results. */
function inTop(results: { id: string }[], needle: string, topN: number): boolean {
  return ids(results).slice(0, topN).includes(needle);
}

// ---------------------------------------------------------------------------
// Suite 1: Error propagation — Dev A teaches, Dev B benefits
// ---------------------------------------------------------------------------

describe("Suite 1: Error propagation (Dev A teaches, Dev B benefits)", () => {
  let db: Database;
  let teamId: string;
  const devAId = "dev-alice";
  const devBId = "dev-bob";
  const stripeEntryId = "entry-stripe-webhook-sig";

  beforeAll(async () => {
    db = initDatabase(":memory:");
    initTeamSchema(db);
    initActivitySchema(db);

    // Create a 5-member team
    const team = createTeam(db, "Platform Team");
    teamId = team.teamId;

    // Seed 4 extra developers via invite/join (gives them real developer IDs)
    for (const name of ["Carol", "Dave", "Eve"]) {
      const inviteKey = createInviteKey(db, teamId);
      await joinTeam(db, inviteKey, name);
    }

    // Dev A encounters and logs the Stripe webhook signature error
    insertEntry(db, {
      id: stripeEntryId,
      type: "error_pattern",
      title: "Stripe webhook signature verification failed raw body parser",
      content:
        "Stripe webhook endpoint returns 400 because express json middleware consumes " +
        "the raw body before signature verification. Fix: use express.raw({type: 'application/json'}) " +
        "on the webhook route before any json parser.",
      files: ["src/webhooks/stripe.ts"],
      tags: ["stripe", "webhook", "signature"],
      errorSignature: "stripe-webhook-sig-<N>",
      confidence: 0.9,
      sourceCount: 1,
      scope: "team",
      developerId: devAId,
    });

    // Log Dev A's learn activity
    logActivity(db, teamId, devAId, "learn", stripeEntryId, [
      "src/webhooks/stripe.ts",
    ]);

    // Seed 5 unrelated noise entries so BM25 has to discriminate
    const noiseEntries = [
      {
        id: "noise-1",
        type: "error_pattern" as const,
        title: "JWT token expiry causes 401 on refresh",
        content:
          "Access token expires after one hour. Client must call refresh endpoint " +
          "before expiry to obtain a new token without forcing logout.",
        files: ["src/auth/tokens.ts"],
        tags: ["auth", "jwt", "token"],
        confidence: 0.8,
        sourceCount: 2,
        scope: "team" as const,
      },
      {
        id: "noise-2",
        type: "convention" as const,
        title: "Use Zod for request body validation on all API routes",
        content:
          "Every API route handler must validate req.body with a Zod schema " +
          "before touching any service layer or database.",
        files: ["src/api/middleware.ts"],
        tags: ["zod", "validation", "api"],
        confidence: 0.95,
        sourceCount: 5,
        scope: "team" as const,
      },
      {
        id: "noise-3",
        type: "learning" as const,
        title: "Prisma migration requires database restart on enum changes",
        content:
          "Adding a new enum value to a Prisma schema requires restarting the " +
          "database connection pool after running prisma migrate deploy.",
        files: ["prisma/schema.prisma"],
        tags: ["prisma", "migration", "enum"],
        confidence: 0.75,
        sourceCount: 1,
        scope: "team" as const,
      },
      {
        id: "noise-4",
        type: "error_pattern" as const,
        title: "Redis connection timeout on cold start",
        content:
          "Redis client times out on the first request after a cold start " +
          "because the connection pool has not warmed up yet. Add retry logic.",
        files: ["src/cache/redis.ts"],
        tags: ["redis", "cache", "timeout"],
        confidence: 0.7,
        sourceCount: 2,
        scope: "team" as const,
      },
      {
        id: "noise-5",
        type: "decision" as const,
        title: "Use BullMQ for background job processing",
        content:
          "Chose BullMQ over Agenda because BullMQ has first-class TypeScript " +
          "support, Redis-backed durability, and active maintenance.",
        files: ["src/jobs/queue.ts"],
        tags: ["bullmq", "queue", "jobs"],
        confidence: 0.88,
        sourceCount: 3,
        scope: "team" as const,
      },
    ];

    for (const entry of noiseEntries) {
      insertEntry(db, entry);
    }
  });

  afterAll(() => {
    db.close();
  });

  test("Dev B finds Dev A's Stripe webhook entry via BM25 keyword search", () => {
    // Dev B hits the same error and searches with natural terms
    logActivity(db, teamId, devBId, "recall");

    const results = searchByBM25(db, "stripe webhook signature raw body");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, stripeEntryId, 3)).toBe(true);
  });

  test("Dev B finds Dev A's Stripe webhook entry via file path lookup", () => {
    const results = searchByFilePath(db, ["src/webhooks/stripe.ts"]);
    expect(results.length).toBeGreaterThan(0);
    expect(ids(results)).toContain(stripeEntryId);
  });

  test("Dev B's recall search is visible in team activity log", () => {
    const activity = getRecentActivity(db, teamId, 1);
    const actions = activity.map((a) => a.action);
    // At least one recall and one learn event should be logged
    expect(actions).toContain("learn");
    expect(actions).toContain("recall");
  });

  test("Dev A's entry carries the original developer attribution", () => {
    const row = db
      .query<{ developer_id: string }, [string]>(
        "SELECT developer_id FROM entries WHERE id = ?",
      )
      .get(stripeEntryId);
    expect(row?.developer_id).toBe(devAId);
  });

  test("Stripe entry is scoped to team so all members can access it", () => {
    const row = db
      .query<{ scope: string }, [string]>("SELECT scope FROM entries WHERE id = ?")
      .get(stripeEntryId);
    expect(row?.scope).toBe("team");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Convention sharing — new conventions spread across the team
// ---------------------------------------------------------------------------

describe("Suite 2: Convention sharing (new code standards spread across the team)", () => {
  let db: Database;
  let teamId: string;
  const devAId = "dev-alice-conv";
  const conventionId = "entry-zod-convention";

  beforeAll(async () => {
    db = initDatabase(":memory:");
    initTeamSchema(db);

    const team = createTeam(db, "Full-Stack Team");
    teamId = team.teamId;

    // Dev A documents the zod validation convention
    insertEntry(db, {
      id: conventionId,
      type: "convention",
      title: "Always validate request body with zod schema before database insert",
      content:
        "All api routes must parse request body through a zod schema before " +
        "touching the database. Reject with 400 on validation error. " +
        "Never pass raw req.body to Prisma.",
      files: ["src/api/users.ts", "src/api/posts.ts"],
      tags: ["zod", "validation", "api"],
      confidence: 0.95,
      sourceCount: 1,
      scope: "team",
      developerId: devAId,
    });

    // Seed realistic noise entries
    const noise = [
      {
        id: "conv-noise-1",
        type: "convention" as const,
        title: "Use React Query for server state management",
        content:
          "Client components must use React Query hooks for fetching and caching " +
          "server data. Do not manage server state in useState.",
        files: ["src/components/UserList.tsx"],
        tags: ["react", "query", "state"],
        confidence: 0.9,
        sourceCount: 3,
        scope: "team" as const,
      },
      {
        id: "conv-noise-2",
        type: "error_pattern" as const,
        title: "Next.js hydration mismatch on server-rendered timestamps",
        content:
          "Server-rendered Date.now() values cause hydration mismatch. " +
          "Use useEffect to render timestamps client-side only.",
        files: ["src/components/CreatedAt.tsx"],
        tags: ["nextjs", "hydration", "ssr"],
        confidence: 0.85,
        sourceCount: 2,
        scope: "team" as const,
      },
      {
        id: "conv-noise-3",
        type: "learning" as const,
        title: "TypeScript strict mode catches undefined access at compile time",
        content:
          "Enabling strict mode in tsconfig catches potential undefined property " +
          "access before runtime. All new projects must start with strict: true.",
        files: ["tsconfig.json"],
        tags: ["typescript", "strict", "config"],
        confidence: 0.92,
        sourceCount: 4,
        scope: "team" as const,
      },
      {
        id: "conv-noise-4",
        type: "convention" as const,
        title: "Tailwind class order must follow Prettier plugin convention",
        content:
          "Run prettier with tailwindcss plugin on all JSX files to enforce " +
          "consistent class ordering. CI lint step will fail on unsorted classes.",
        files: ["src/components/Button.tsx"],
        tags: ["tailwind", "prettier", "css"],
        confidence: 0.88,
        sourceCount: 2,
        scope: "team" as const,
      },
      {
        id: "conv-noise-5",
        type: "decision" as const,
        title: "Use tRPC for type-safe API contracts between client and server",
        content:
          "tRPC was chosen over REST because it provides end-to-end type safety " +
          "without code generation, reducing contract drift between frontend and backend.",
        files: ["src/server/router.ts"],
        tags: ["trpc", "typescript", "api"],
        confidence: 0.91,
        sourceCount: 5,
        scope: "team" as const,
      },
    ];

    for (const entry of noise) {
      insertEntry(db, entry);
    }
  });

  afterAll(() => {
    db.close();
  });

  test("Dev B finds zod convention via 'zod validation request body api route'", () => {
    const results = searchByBM25(db, "zod validation request body api route");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, conventionId, 5)).toBe(true);
  });

  test("Dev C finds zod convention via 'validate request body schema database insert'", () => {
    const results = searchByBM25(
      db,
      "validate request body schema database insert",
    );
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, conventionId, 5)).toBe(true);
  });

  test("Dev D finds zod convention via 'api routes zod schema reject validation'", () => {
    const results = searchByBM25(db, "api routes zod schema reject validation");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, conventionId, 5)).toBe(true);
  });

  test("Zod convention is type=convention and scope=team", () => {
    const row = db
      .query<{ type: string; scope: string }, [string]>(
        "SELECT type, scope FROM entries WHERE id = ?",
      )
      .get(conventionId);
    expect(row?.type).toBe("convention");
    expect(row?.scope).toBe("team");
  });

  test("Convention is also discoverable via file path used by team members", () => {
    const results = searchByFilePath(db, ["src/api/users.ts"]);
    expect(ids(results)).toContain(conventionId);
  });

  test("Convention is discoverable via second associated file path", () => {
    const results = searchByFilePath(db, ["src/api/posts.ts"]);
    expect(ids(results)).toContain(conventionId);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Ghost knowledge reaches all developers
// ---------------------------------------------------------------------------

describe("Suite 3: Ghost knowledge (org-wide truth reaches every developer)", () => {
  let db: Database;
  const ghostId = "ghost-db-migration-approvals";

  beforeAll(() => {
    db = initDatabase(":memory:");

    // Seed the ghost knowledge entry — cannot come from learn tool, inserted directly
    insertEntry(db, {
      id: ghostId,
      type: "ghost_knowledge",
      title: "Production database migrations require backup and two approvals",
      content:
        "Every production database migration must have a full backup snapshot " +
        "taken within the last hour and be approved by two senior engineers " +
        "before execution. No exceptions for hotfixes.",
      files: [],
      tags: ["database", "migration", "production", "approval"],
      confidence: 1.0,
      sourceCount: 1,
      scope: "team",
      status: "active",
    });

    // Seed 20 noise entries about database migrations at varying confidences
    for (let i = 1; i <= 20; i++) {
      const confidence = 0.3 + (i % 7) * 0.08; // varies 0.30 – 0.78
      insertEntry(db, {
        id: `noise-migration-${i}`,
        type: i % 3 === 0 ? "error_pattern" : i % 2 === 0 ? "learning" : "convention",
        title: `Database migration note ${i}`,
        content: `Database migration detail ${i}: track schema changes with version control and test migrations on staging before production deployment.`,
        files: [`migrations/V${i}__change.sql`],
        tags: ["database", "migration"],
        confidence,
        sourceCount: 1,
        scope: "team",
        status: "active",
      });
    }
  });

  afterAll(() => {
    db.close();
  });

  test("Dev 1 finds ghost entry when searching for 'production database migration backup'", () => {
    const results = searchByBM25(db, "production database migration backup");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, ghostId, 5)).toBe(true);
  });

  test("Dev 2 finds ghost entry when searching for 'migration approval senior engineers'", () => {
    const results = searchByBM25(db, "migration approval senior engineers");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, ghostId, 5)).toBe(true);
  });

  test("Dev 3 finds ghost entry when searching for 'backup snapshot before execution'", () => {
    const results = searchByBM25(db, "backup snapshot before execution");
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, ghostId, 5)).toBe(true);
  });

  test("Dev 4 finds ghost entry when searching for 'production migration two approvals hotfix'", () => {
    const results = searchByBM25(
      db,
      "production migration two approvals hotfix",
    );
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, ghostId, 5)).toBe(true);
  });

  test("Dev 5 finds ghost entry when searching for 'database migration engineer approval snapshot'", () => {
    const results = searchByBM25(
      db,
      "database migration engineer approval snapshot",
    );
    expect(results.length).toBeGreaterThan(0);
    expect(inTop(results, ghostId, 5)).toBe(true);
  });

  test("Ghost entry confidence stays at 1.0 after all developer searches", () => {
    // Searches are read-only — ghost confidence must not decay
    const row = db
      .query<{ confidence: number }, [string]>(
        "SELECT confidence FROM entries WHERE id = ?",
      )
      .get(ghostId);
    expect(row?.confidence).toBe(1.0);
  });

  test("Ghost entry status stays 'active' after all developer searches", () => {
    const row = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM entries WHERE id = ?",
      )
      .get(ghostId);
    expect(row?.status).toBe("active");
  });

  test("Ghost entry type is 'ghost_knowledge'", () => {
    const row = db
      .query<{ type: string }, [string]>(
        "SELECT type FROM entries WHERE id = ?",
      )
      .get(ghostId);
    expect(row?.type).toBe("ghost_knowledge");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Personal scope privacy isolation
// ---------------------------------------------------------------------------

describe("Suite 4: Personal scope privacy isolation", () => {
  let db: Database;
  const devAId = "dev-alpha";
  const devBId = "dev-beta";
  const devCId = "dev-gamma";

  // Personal entry IDs per developer
  const devAPersonalIds = [
    "alpha-personal-1",
    "alpha-personal-2",
    "alpha-personal-3",
  ];
  const devBPersonalIds = [
    "beta-personal-1",
    "beta-personal-2",
    "beta-personal-3",
  ];
  const devCPersonalIds = [
    "gamma-personal-1",
    "gamma-personal-2",
    "gamma-personal-3",
  ];

  // Team entry IDs
  const teamEntryIds = ["team-shared-1", "team-shared-2"];

  beforeAll(() => {
    db = initDatabase(":memory:");

    // ---- Dev A personal entries (Stripe local dev notes) ----
    insertEntry(db, {
      id: devAPersonalIds[0],
      type: "learning",
      title: "Personal debug note Stripe test webhook localhost tunnel",
      content:
        "To test Stripe webhooks locally use stripe listen --forward-to " +
        "localhost:3000/webhooks/stripe. Save the webhook signing secret " +
        "from stripe cli to .env.local.",
      files: ["src/webhooks/stripe.ts"],
      tags: ["stripe", "webhook", "local", "debug"],
      confidence: 0.8,
      sourceCount: 1,
      scope: "personal",
      developerId: devAId,
    });

    insertEntry(db, {
      id: devAPersonalIds[1],
      type: "learning",
      title: "Personal note ngrok tunnel port 3000 stripe webhook testing",
      content:
        "ngrok http 3000 gives a public tunnel for webhook testing. Copy " +
        "the https forwarding URL and paste into Stripe dashboard events endpoint.",
      files: ["src/webhooks/stripe.ts"],
      tags: ["ngrok", "tunnel", "stripe"],
      confidence: 0.75,
      sourceCount: 1,
      scope: "personal",
      developerId: devAId,
    });

    insertEntry(db, {
      id: devAPersonalIds[2],
      type: "error_pattern",
      title: "Personal note Stripe CLI webhook secret resets on restart",
      content:
        "The stripe cli webhook signing secret changes every time you restart " +
        "stripe listen. Always copy the new secret to STRIPE_WEBHOOK_SECRET in .env.local.",
      files: ["src/webhooks/stripe.ts", ".env.local"],
      tags: ["stripe", "cli", "secret"],
      confidence: 0.85,
      sourceCount: 1,
      scope: "personal",
      developerId: devAId,
    });

    // ---- Dev B personal entries (Prisma local dev notes) ----
    insertEntry(db, {
      id: devBPersonalIds[0],
      type: "learning",
      title: "Personal note Prisma studio database browser localhost 5555",
      content:
        "Run npx prisma studio to open a browser-based database explorer on " +
        "localhost:5555. Useful for inspecting rows during local development.",
      files: ["prisma/schema.prisma"],
      tags: ["prisma", "studio", "database", "local"],
      confidence: 0.8,
      sourceCount: 1,
      scope: "personal",
      developerId: devBId,
    });

    insertEntry(db, {
      id: devBPersonalIds[1],
      type: "error_pattern",
      title: "Personal note Prisma migration drift error on local database",
      content:
        "Prisma detects migration drift when the local database schema does " +
        "not match migration history. Fix with prisma migrate reset to rebuild " +
        "the local database from scratch.",
      files: ["prisma/schema.prisma"],
      tags: ["prisma", "migration", "drift"],
      confidence: 0.78,
      sourceCount: 1,
      scope: "personal",
      developerId: devBId,
    });

    insertEntry(db, {
      id: devBPersonalIds[2],
      type: "learning",
      title: "Personal note Prisma generate must run after schema changes",
      content:
        "Always run npx prisma generate after editing prisma/schema.prisma. " +
        "The TypeScript client types won't reflect new fields until regenerated.",
      files: ["prisma/schema.prisma"],
      tags: ["prisma", "generate", "types"],
      confidence: 0.82,
      sourceCount: 1,
      scope: "personal",
      developerId: devBId,
    });

    // ---- Dev C personal entries (Docker local dev notes) ----
    insertEntry(db, {
      id: devCPersonalIds[0],
      type: "learning",
      title: "Personal note Docker compose watch hot reload development",
      content:
        "Use docker compose watch instead of docker compose up to enable " +
        "hot reload of application code without rebuilding the container image.",
      files: ["docker-compose.yml"],
      tags: ["docker", "compose", "hotreload"],
      confidence: 0.8,
      sourceCount: 1,
      scope: "personal",
      developerId: devCId,
    });

    insertEntry(db, {
      id: devCPersonalIds[1],
      type: "error_pattern",
      title: "Personal note Docker build cache stale after package.json change",
      content:
        "Docker layer cache becomes stale when package.json changes. Force " +
        "a full rebuild with docker build --no-cache to install updated dependencies.",
      files: ["Dockerfile"],
      tags: ["docker", "cache", "build"],
      confidence: 0.77,
      sourceCount: 1,
      scope: "personal",
      developerId: devCId,
    });

    insertEntry(db, {
      id: devCPersonalIds[2],
      type: "learning",
      title: "Personal note Docker desktop memory limit causes OOM on large builds",
      content:
        "Docker Desktop defaults to 2GB memory which is insufficient for " +
        "large monorepo builds. Increase memory limit to at least 4GB in " +
        "Docker Desktop preferences.",
      files: ["Dockerfile"],
      tags: ["docker", "memory", "oom"],
      confidence: 0.83,
      sourceCount: 1,
      scope: "personal",
      developerId: devCId,
    });

    // ---- Team-scoped shared entries ----
    insertEntry(db, {
      id: teamEntryIds[0],
      type: "convention",
      title: "All environment variables must be documented in env.example",
      content:
        "Every new environment variable added to the application must have " +
        "a corresponding entry in .env.example with a descriptive comment. " +
        "Missing entries cause onboarding failures for new developers.",
      files: [".env.example"],
      tags: ["env", "config", "onboarding"],
      confidence: 0.95,
      sourceCount: 3,
      scope: "team",
    });

    insertEntry(db, {
      id: teamEntryIds[1],
      type: "convention",
      title: "Feature flags must be cleaned up within one sprint after rollout",
      content:
        "Feature flags older than one sprint after full rollout must be " +
        "removed from code. Stale flags accumulate technical debt and make " +
        "the codebase harder to reason about.",
      files: ["src/features/flags.ts"],
      tags: ["feature-flag", "technical-debt", "cleanup"],
      confidence: 0.9,
      sourceCount: 4,
      scope: "team",
    });
  });

  afterAll(() => {
    db.close();
  });

  // ---- SQL-level privacy verification ----

  test("SQL query: Dev A has exactly 3 personal entries", () => {
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE scope = 'personal' AND developer_id = ?",
      )
      .all(devAId);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual([...devAPersonalIds].sort());
  });

  test("SQL query: Dev B has exactly 3 personal entries", () => {
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE scope = 'personal' AND developer_id = ?",
      )
      .all(devBId);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual([...devBPersonalIds].sort());
  });

  test("SQL query: Dev C has exactly 3 personal entries", () => {
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM entries WHERE scope = 'personal' AND developer_id = ?",
      )
      .all(devCId);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual([...devCPersonalIds].sort());
  });

  // ---- BM25 scope filter: Dev A can see own personal entries ----

  test("Dev A can find their own personal Stripe tunnel entry via BM25", () => {
    const results = searchByBM25(db, "stripe webhook localhost tunnel", undefined, devAId);
    expect(results.length).toBeGreaterThan(0);
    // At least one of Dev A's personal stripe entries should surface
    const foundIds = ids(results);
    const hasPersonal = devAPersonalIds.some((pid) => foundIds.includes(pid));
    expect(hasPersonal).toBe(true);
  });

  test("Dev A can also see team-scoped entries alongside their personal ones", () => {
    const results = searchByBM25(db, "environment variable documented onboarding", undefined, devAId);
    expect(results.length).toBeGreaterThan(0);
    expect(ids(results)).toContain(teamEntryIds[0]);
  });

  // ---- BM25 scope filter: Dev B cannot see Dev A's personal entries ----

  test("Dev B cannot see Dev A's personal Stripe tunnel entry via BM25", () => {
    const results = searchByBM25(db, "stripe webhook localhost tunnel", undefined, devBId);
    const foundIds = ids(results);
    for (const pid of devAPersonalIds) {
      expect(foundIds).not.toContain(pid);
    }
  });

  test("Dev B cannot see Dev A's personal entries even with broad stripe query", () => {
    const results = searchByBM25(db, "stripe cli webhook secret local", undefined, devBId);
    const foundIds = ids(results);
    for (const pid of devAPersonalIds) {
      expect(foundIds).not.toContain(pid);
    }
  });

  // ---- BM25 scope filter: Dev C cannot see Dev B's personal entries ----

  test("Dev C cannot see Dev B's personal Prisma studio entry", () => {
    const results = searchByBM25(db, "prisma studio browser database local", undefined, devCId);
    const foundIds = ids(results);
    for (const pid of devBPersonalIds) {
      expect(foundIds).not.toContain(pid);
    }
  });

  // ---- Anonymous query (no developerId) returns only team entries ----

  test("Anonymous search (no developerId) returns no personal entries at all", () => {
    // Search broad enough to potentially match all personal entries
    const results = searchByBM25(db, "personal webhook stripe prisma docker");
    const foundIds = ids(results);
    const allPersonalIds = [
      ...devAPersonalIds,
      ...devBPersonalIds,
      ...devCPersonalIds,
    ];
    for (const pid of allPersonalIds) {
      expect(foundIds).not.toContain(pid);
    }
  });

  test("Anonymous search still returns team-scoped entries", () => {
    const results = searchByBM25(db, "environment variable documented onboarding");
    expect(ids(results)).toContain(teamEntryIds[0]);
  });

  // ---- Dev B can see their own personal Prisma entries ----

  test("Dev B can find their own personal Prisma migration drift entry", () => {
    const results = searchByBM25(db, "prisma migration drift local database", undefined, devBId);
    expect(results.length).toBeGreaterThan(0);
    const foundIds = ids(results);
    const hasPersonal = devBPersonalIds.some((pid) => foundIds.includes(pid));
    expect(hasPersonal).toBe(true);
  });
});
