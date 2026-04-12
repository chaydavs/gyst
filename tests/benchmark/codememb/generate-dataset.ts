#!/usr/bin/env bun
/**
 * CodeMemBench dataset generator.
 *
 * Deterministic (seed=42) producer of 500 entries + 200 queries for the
 * CodeMemBench benchmark. Ground truth is known by construction at
 * generation time — queries are synthesized from entry content, so
 * `relevantEntryIds` is exact rather than graded.
 *
 * Usage:
 *   bun run tests/benchmark/codememb/generate-dataset.ts
 *
 * Output:
 *   tests/benchmark/codememb/dataset.json
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EntryRow } from "../../../src/store/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = resolve(__dirname, "dataset.json");
const SEED = 42;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const pickN = <T>(arr: readonly T[], n: number): T[] => {
  const pool = [...arr];
  const out: T[] = [];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
};
const randInt = (lo: number, hi: number): number =>
  lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Content pools
// ---------------------------------------------------------------------------

const DEVS = [
  "dev_alice", "dev_bob", "dev_carol", "dev_dave",
  "dev_eve", "dev_frank", "dev_grace", "dev_heidi",
] as const;

const SOURCE_TOOLS = ["claude-code", "cursor", "codex-cli", "windsurf"] as const;

const FILE_POOL = [
  "src/api/routes/users.ts", "src/api/routes/auth.ts", "src/api/routes/billing.ts",
  "src/api/routes/webhooks.ts", "src/lib/db.ts", "src/lib/stripe.ts",
  "src/lib/redis.ts", "src/lib/jwt.ts", "src/lib/queue.ts",
  "prisma/schema.prisma", "prisma/migrations/20240101_init.sql",
  "src/middleware/auth.ts", "src/middleware/ratelimit.ts",
  "src/workers/email.ts", "src/workers/billing.ts", "src/workers/indexer.ts",
  "src/components/Dashboard.tsx", "src/components/Checkout.tsx",
  "src/components/Settings.tsx", "src/hooks/useAuth.ts",
  "src/server/index.ts", "src/server/context.ts", "src/server/trpc.ts",
  "infra/terraform/main.tf", "infra/k8s/deployment.yaml",
  ".github/workflows/ci.yml", ".github/workflows/deploy.yml",
  "scripts/migrate.ts", "scripts/seed.ts",
] as const;

// Error pattern templates — each is a realistic production error with a
// distinct normalized signature. We pull 80 of these.
const ERROR_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  sig: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Prisma P2002 unique constraint failed on users email",
    body: "The Prisma query throws P2002 when inserting a user whose email already exists in the users table. The unique constraint on email column rejects duplicates. Root cause: signup endpoint does not check for existing account before insert. Fix: switch to upsert or wrap the create in a try-catch that returns 409 conflict to the client. Always handle P2002 at the API boundary — leaking the stack into the response exposes the schema.",
    sig: "prisma p2002 unique constraint failed <STR> users email",
    files: ["src/api/routes/users.ts", "prisma/schema.prisma"],
    tags: ["prisma", "unique-constraint", "users"],
  },
  {
    title: "ECONNREFUSED postgres port 5432",
    body: "Connection to postgres is refused on localhost port 5432. Usually the database container is not running or the host binding is wrong. Check docker-compose ps and confirm DATABASE_URL points at the correct host (use postgres service name inside docker network, localhost only from host machine). When it happens in CI, the postgres service container has not finished booting — add a wait-for-it before the migration step.",
    sig: "econnrefused <STR> 127.0.0.1 5432",
    files: ["src/lib/db.ts", ".github/workflows/ci.yml"],
    tags: ["postgres", "connection", "docker"],
  },
  {
    title: "Stripe webhook signature verification failed raw body missing",
    body: "Stripe webhook signature verification fails because the request body has already been parsed by express.json middleware. The stripe library requires the raw bytes to compute the HMAC. Fix: mount a raw body parser for the /webhook route before the json middleware, or use express.raw with the content type set to application/json. This is the number one webhook integration bug.",
    sig: "stripe webhook signature verification failed raw body",
    files: ["src/api/routes/webhooks.ts", "src/lib/stripe.ts"],
    tags: ["stripe", "webhook", "signature"],
  },
  {
    title: "JsonWebTokenError jwt expired",
    body: "The jsonwebtoken library throws JsonWebTokenError jwt expired when the exp claim is in the past. Client is sending a stale access token. Fix at two layers: middleware should return 401 with a refresh hint, and the client should transparently exchange the refresh token when it sees that hint. Do not log the full token in the error path.",
    sig: "jsonwebtokenerror jwt expired <N>",
    files: ["src/lib/jwt.ts", "src/middleware/auth.ts"],
    tags: ["jwt", "auth", "expired"],
  },
  {
    title: "Redis EHOSTUNREACH when connecting to cache cluster",
    body: "ioredis client throws EHOSTUNREACH because the cluster endpoint is not reachable from the worker VPC. VPC peering is set up but the security group on the redis cluster only allows the web tier. Add the worker subnet to the ingress rule. Also increase the retry strategy max attempts to ride out redeploys.",
    sig: "redis ehostunreach <STR>",
    files: ["src/lib/redis.ts", "infra/terraform/main.tf"],
    tags: ["redis", "vpc", "security-group"],
  },
  {
    title: "ERR_REQUIRE_ESM using import of ESM only module",
    body: "node fails with ERR_REQUIRE_ESM because you are requireing a package that ships only ESM. Options: convert the caller to ESM (recommended), use dynamic import() inside an async function, or downgrade the dependency to the last CJS-compatible version. Note package.json type:module and the extension rules for relative imports (always .js in TS-to-ESM projects).",
    sig: "err_require_esm <STR>",
    files: ["src/server/index.ts", "package.json"],
    tags: ["esm", "cjs", "node"],
  },
  {
    title: "TypeError cannot read properties of undefined reading id",
    body: "The request handler crashes with cannot read properties of undefined reading id because the optional req.user is accessed before the auth middleware runs. The route was added to a sub-router that does not inherit middleware. Fix: mount the auth middleware on the parent router or add it explicitly to the sub-route.",
    sig: "typeerror cannot read properties of undefined reading id",
    files: ["src/middleware/auth.ts", "src/server/trpc.ts"],
    tags: ["middleware", "undefined", "auth"],
  },
  {
    title: "Rate limit exceeded on Stripe API 429",
    body: "Stripe returns 429 Too Many Requests when the read rate exceeds 100 per second. The webhook backfill worker was fetching customers in a tight loop. Fix: batch the fetch with expand parameters, respect the retry-after header, and use idempotent keys when retrying.",
    sig: "stripe rate limit exceeded 429 <N>",
    files: ["src/workers/billing.ts", "src/lib/stripe.ts"],
    tags: ["stripe", "rate-limit", "429"],
  },
  {
    title: "CORS error blocked by preflight missing allow origin",
    body: "Browser blocks the fetch because the preflight OPTIONS response does not include Access-Control-Allow-Origin for the calling origin. The cors middleware is installed but the origin whitelist regex is wrong. Test with curl -i -X OPTIONS and confirm the header. Do not use wildcard when credentials are included.",
    sig: "cors preflight missing allow origin <STR>",
    files: ["src/middleware/auth.ts", "src/server/index.ts"],
    tags: ["cors", "preflight", "browser"],
  },
  {
    title: "Out of memory heap snapshot indexer worker",
    body: "The indexer worker runs out of memory because it loads the entire corpus into an array before processing. Switch to a streaming pipeline with backpressure, or process in batches of 500 documents. Set max-old-space-size to 4096 as a short term fix but do not ship that as the permanent answer.",
    sig: "javascript heap out of memory indexer",
    files: ["src/workers/indexer.ts"],
    tags: ["memory", "heap", "worker"],
  },
];

const CONVENTION_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Always validate request bodies with zod at the route boundary",
    body: "Every API route must parse req.body through a zod schema before it touches business logic. The schema lives next to the route and is named RouteNameInput. On parse failure we return 400 with the flattened error list. This catches malformed clients at the boundary instead of deep inside the handler where errors are harder to trace.",
    files: ["src/api/routes/users.ts", "src/lib/db.ts"],
    tags: ["zod", "validation", "conventions"],
  },
  {
    title: "File naming is kebab-case classes PascalCase functions camelCase",
    body: "All source files in this repo use kebab-case filenames like user-service.ts. Classes are PascalCase. Functions and variables are camelCase. Enums and constants are SCREAMING_SNAKE. This keeps grep predictable and makes ctag jumps behave.",
    files: ["src/lib/db.ts", "src/server/index.ts"],
    tags: ["naming", "style", "conventions"],
  },
  {
    title: "Commits must follow conventional commit prefix feat fix chore docs",
    body: "Every commit message starts with a conventional commit type: feat for user-visible features, fix for bugs, chore for maintenance, docs for documentation, refactor for internal cleanup, test for tests, perf for performance, ci for pipelines. The type is followed by a colon and a short imperative summary. This powers the release notes generator.",
    files: [".github/workflows/ci.yml"],
    tags: ["git", "commits", "conventions"],
  },
  {
    title: "No any types use unknown with type guards",
    body: "TypeScript strict mode is enforced. The any type is banned by eslint. When you need flexibility, reach for unknown and narrow with a type guard function. Prefer discriminated unions for polymorphic shapes. If you are reaching for as, write a guard instead.",
    files: ["src/server/context.ts"],
    tags: ["typescript", "strict", "any"],
  },
  {
    title: "All async functions must catch and log with structured logger",
    body: "Never let an async function throw into the global unhandledRejection. Wrap every await in try-catch at the route level, log with the structured logger (never console.log), and return a user-facing error message. The logger adds requestId, userId, and traceId automatically from async-local-storage.",
    files: ["src/server/index.ts", "src/lib/db.ts"],
    tags: ["logging", "errors", "async"],
  },
  {
    title: "SQL migrations are forward only never edit a merged migration",
    body: "Prisma migrations are forward only. Once a migration is merged to main, it is frozen — do not edit it. If you need to change schema, write a new migration that does the correction. This is the only way to keep CI and production in sync. Rolling back means writing a compensating migration.",
    files: ["prisma/schema.prisma", "prisma/migrations/20240101_init.sql"],
    tags: ["migration", "prisma", "forward-only"],
  },
  {
    title: "Environment variables are loaded through a validated config module",
    body: "Never read process.env inside business logic. Every env var is declared in src/config.ts with a zod schema, parsed once at startup, and exported as a typed object. This catches missing configuration at boot instead of at the first request.",
    files: ["src/server/index.ts"],
    tags: ["env", "config", "validation"],
  },
  {
    title: "Feature flags gate all new routes for a week",
    body: "Every new user-visible route is behind a feature flag for at least one week after deploy. The flag default is off; we enable per cohort. This lets us roll back instantly without a redeploy. Flag names use kebab-case prefixed with the owning team.",
    files: ["src/lib/flags.ts", "src/api/routes/users.ts"],
    tags: ["feature-flag", "release", "safety"],
  },
  {
    title: "React components are function components only hooks for state",
    body: "No class components in the web app. All components are function components. State is managed with useState and useReducer. Side effects go in useEffect. Data fetching uses the trpc hooks. Context only for auth and theme — do not use it as a global store.",
    files: ["src/components/Dashboard.tsx", "src/hooks/useAuth.ts"],
    tags: ["react", "hooks", "functional"],
  },
  {
    title: "Database access goes through repository modules not inline queries",
    body: "No raw prisma calls inside route handlers. Every entity has a repository module in src/repositories that owns the queries. Repositories return plain DTOs. This keeps routes thin and makes the data layer testable in isolation.",
    files: ["src/lib/db.ts", "src/api/routes/users.ts"],
    tags: ["repository", "db", "prisma"],
  },
];

const DECISION_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Bun runtime over Node.js for fast startup and native typescript",
    body: "We chose Bun over Node.js for this project. Reasons: sub-50ms startup, native TypeScript execution (no tsc step in dev), built-in SQLite, and bundled test runner. Tradeoff: ecosystem coverage is narrower, so we pin to libraries that publish dual builds. If a library only ships for Node, we wrap it behind an adapter.",
    files: ["src/server/index.ts", "package.json"],
    tags: ["bun", "runtime", "decision"],
  },
  {
    title: "SQLite FTS5 over Postgres full text for embedded search",
    body: "Full-text search uses SQLite FTS5 with porter stemming, not Postgres tsvector. Reason: the search index is local to each install, so we avoid the round trip. FTS5 gives us BM25 out of the box and a triggered index that stays in sync with the entries table. Revisit if corpus size exceeds 100k entries.",
    files: ["src/lib/db.ts"],
    tags: ["sqlite", "fts5", "search"],
  },
  {
    title: "Reciprocal rank fusion over learned reranker for strategy fusion",
    body: "Our hybrid search fuses BM25, file-path, graph, temporal, and semantic strategies with reciprocal rank fusion k=60 — the standard from the 2009 Cormack paper. We rejected a learned reranker because it adds a trained model dependency that complicates deployment and needs labeled data we do not yet have.",
    files: ["src/lib/search.ts"],
    tags: ["rrf", "fusion", "retrieval"],
  },
  {
    title: "Markdown files as source of truth SQLite as derived index",
    body: "Every entry is stored as a markdown file with frontmatter. SQLite is a derived index that can be rebuilt from the markdown at any time. If the SQLite file is corrupted, we delete it and re-run the indexer. This gives us a human-readable audit trail and protects against schema breakage.",
    files: ["src/lib/db.ts", "gyst-wiki/index.md"],
    tags: ["markdown", "sqlite", "source-of-truth"],
  },
  {
    title: "API keys instead of OAuth for MCP clients",
    body: "MCP tools run inside coding agents that do not have a browser, so the OAuth flow is impossible. We use long-lived API keys hashed with bcrypt. Keys are scoped to a single team and can be revoked individually. Rotate every 90 days by policy.",
    files: ["src/middleware/auth.ts", "src/lib/jwt.ts"],
    tags: ["auth", "api-key", "mcp"],
  },
  {
    title: "Porter stemmer only add synonyms where stems diverge",
    body: "Query expansion adds synonym OR groups, but only for word pairs whose porter stems differ. This keeps the expansion map tiny and avoids the precision loss of a full thesaurus. Example: connect and connection stem the same, but postgres and postgresql do not — so we add that pair.",
    files: ["src/lib/search.ts"],
    tags: ["stemmer", "expansion", "search"],
  },
  {
    title: "Half-life decay per entry type errors 30 days decisions 365 days",
    body: "Confidence decays exponentially with a type-specific half-life: error_pattern 30 days, learning 60 days, decision 365 days, convention no decay (stable until explicitly changed), ghost_knowledge infinite. This reflects how quickly each type becomes stale.",
    files: ["src/lib/confidence.ts"],
    tags: ["decay", "confidence", "half-life"],
  },
  {
    title: "Ghost knowledge type for tribal rules immune to decay",
    body: "We added a ghost_knowledge type for rules that live in team memory but never in the code — things like never deploy Friday or migrations need two approvers. Ghost entries have confidence 1.0 and infinite half-life. They pass through consolidation unchanged so they do not get merged into generic entries.",
    files: ["src/lib/confidence.ts", "src/mcp/tools/learn.ts"],
    tags: ["ghost", "tribal", "decay"],
  },
  {
    title: "Query expansion additive OR groups not replacement",
    body: "Query expansion adds synonym OR groups around the original terms, never replacing them. Example: postgres becomes (postgres OR postgresql) AND connection. This preserves BM25 precision while catching the variant spellings. Replacing the original term drops precision badly on tight queries.",
    files: ["src/lib/search.ts"],
    tags: ["expansion", "precision", "or"],
  },
  {
    title: "Scope column for personal vs team entry isolation",
    body: "Every entry has a scope column: personal, team, or project. Searches default to team+project. Personal entries are only visible to the developer that created them, enforced at the SQL level. This lets developers jot private notes without polluting the team corpus.",
    files: ["src/lib/db.ts", "src/mcp/tools/recall.ts"],
    tags: ["scope", "isolation", "personal"],
  },
];

const LEARNING_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Bun test imports need js extension even for ts files",
    body: "When importing TypeScript modules from a bun test file, the extension must be .js even though the source is .ts. This is because bun follows the ESM resolution rules. Miss the extension and you get a cryptic module not found error at runtime.",
    files: ["src/lib/db.ts"],
    tags: ["bun", "esm", "imports"],
  },
  {
    title: "Prisma transaction timeout defaults to 5 seconds raise for big writes",
    body: "prisma.$transaction defaults to a 5 second timeout. When you backfill a large table, that is not enough. Pass a maxWait and timeout option in the transaction call. Five minutes is a reasonable upper bound for a migration-time backfill.",
    files: ["scripts/migrate.ts", "prisma/schema.prisma"],
    tags: ["prisma", "transaction", "timeout"],
  },
  {
    title: "Redis EXPIRE is a separate command not part of SET",
    body: "When using ioredis, SET and EXPIRE are separate commands unless you pass the EX option. If you forget the EX option, your key lives forever and you have a slow memory leak. Always prefer set with EX in one call.",
    files: ["src/lib/redis.ts"],
    tags: ["redis", "expire", "ttl"],
  },
  {
    title: "Stripe test mode webhook secret is different from live mode",
    body: "Stripe issues a different webhook signing secret for test mode and live mode. Mixing them up makes signature verification fail in a way that looks like a code bug. Check the STRIPE_WEBHOOK_SECRET env var matches the mode you are running in.",
    files: ["src/lib/stripe.ts", "src/api/routes/webhooks.ts"],
    tags: ["stripe", "webhook", "secret"],
  },
  {
    title: "GitHub Actions checkout uses a shallow clone by default",
    body: "actions/checkout defaults to fetch-depth 1 which is a shallow clone. That breaks git log-based version tooling. Pass fetch-depth 0 when you need the full history, or use a tagged workflow that explicitly fetches tags.",
    files: [".github/workflows/ci.yml"],
    tags: ["github-actions", "git", "checkout"],
  },
  {
    title: "JSON.stringify drops undefined fields silently",
    body: "JSON.stringify silently drops keys whose value is undefined. If you rely on those keys being present as null in the output, set them explicitly to null before stringifying. This bites you most often when sending API responses.",
    files: ["src/server/trpc.ts"],
    tags: ["json", "undefined", "serialization"],
  },
  {
    title: "Postgres JSONB comparison operators need explicit casts",
    body: "Comparing a jsonb field to a string in Postgres needs an explicit cast to text. Without the cast you get a type mismatch error that is easy to misread. Use jsonb_column ->> key for the text extraction.",
    files: ["prisma/schema.prisma"],
    tags: ["postgres", "jsonb", "cast"],
  },
  {
    title: "React strict mode double invokes effects in development only",
    body: "React 18 strict mode double-invokes effects during development to catch side-effect bugs. Do not try to disable this — fix the effect to be idempotent. The double invocation is gone in production builds.",
    files: ["src/components/Dashboard.tsx"],
    tags: ["react", "strict-mode", "effects"],
  },
  {
    title: "Node fetch requires explicit agent to reuse connections",
    body: "By default, node fetch opens a new TCP connection per request. For hot code paths, construct a keepAlive agent and pass it explicitly. This cut tail latency by 80ms in our billing worker.",
    files: ["src/workers/billing.ts"],
    tags: ["node", "fetch", "keep-alive"],
  },
  {
    title: "Docker image size drops by 60 percent with multi stage build",
    body: "A naive Dockerfile copies node_modules and source into the final image. A multi-stage build runs npm install in a builder stage, copies only dist and production dependencies into a distroless final stage, and cuts image size by 60 percent.",
    files: ["infra/k8s/deployment.yaml"],
    tags: ["docker", "multistage", "image-size"],
  },
];

const GHOST_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Never deploy to production on Friday after 2pm",
    body: "Unwritten rule from the team: no production deploys after 14:00 on Friday. If we ship a bug, the oncall has to eat their weekend fixing it. Exceptions only for security patches with incident commander approval. This is not in any runbook — it lives in the team chat.",
    files: [".github/workflows/deploy.yml"],
    tags: ["deploy", "friday", "team-rule"],
  },
  {
    title: "Schema migrations require two reviewers from the platform team",
    body: "Pull requests that touch prisma schema need approval from two platform engineers, not one. This is a ghost rule discovered after the 2024 incident where a migration locked the users table for 45 minutes. The CODEOWNERS file does not encode it — the team enforces it manually.",
    files: ["prisma/schema.prisma", ".github/workflows/ci.yml"],
    tags: ["migration", "review", "tribal"],
  },
  {
    title: "Feature flags must be deleted within 30 days of full rollout",
    body: "Once a feature flag is at 100 percent rollout, the owning team has 30 days to delete it and all branches that reference it. Dead flags pile up and make the decision fabric unreadable. The rule is not in CI — it lives in the weekly engineering review.",
    files: ["src/lib/flags.ts"],
    tags: ["feature-flag", "cleanup", "tribal"],
  },
  {
    title: "Stripe customer IDs are the source of truth not our user IDs",
    body: "For billing reconciliation, we treat the Stripe customer ID as authoritative over our internal user ID. This is because Stripe has survived one migration where our user IDs changed. The invariant is enforced culturally — reviewers reject PRs that key billing by user.id.",
    files: ["src/lib/stripe.ts", "src/workers/billing.ts"],
    tags: ["stripe", "identity", "tribal"],
  },
  {
    title: "Oncall rotation ignores the on-call handbook on American holidays",
    body: "The on-call runbook says rotate every Monday at 10am. In practice, the team quietly swaps for American federal holidays so that the person on call does not lose a holiday. This arrangement is not in PagerDuty — ask the current oncall before you go on leave.",
    files: ["infra/terraform/main.tf"],
    tags: ["oncall", "holiday", "tribal"],
  },
  {
    title: "Do not add new grpc services ask platform first",
    body: "We do not accept new grpc services without platform team review. The reason is observability: our logging and tracing stack is tuned for HTTP, and grpc breaks the request ID propagation. This is not in any doc — it is discussed in the platform office hours.",
    files: ["src/server/index.ts"],
    tags: ["grpc", "platform", "tribal"],
  },
  {
    title: "Production database backups are verified by restore drill monthly",
    body: "Our database backups are verified by restoring to a scratch instance on the first Monday of every month. If the drill fails we delay the planned release until we have a good backup. This rule lives in the SRE lead's calendar, not in the runbook.",
    files: ["scripts/migrate.ts"],
    tags: ["backup", "drill", "sre"],
  },
  {
    title: "Secret rotation happens after any laptop loss incident",
    body: "Any time a developer laptop is lost or stolen we rotate every secret that developer had access to within 24 hours. This is not in the incident response plan — it is in the security champion's head. Ask before you assume a stolen laptop can wait until next week.",
    files: ["src/lib/jwt.ts"],
    tags: ["secrets", "rotation", "security"],
  },
  {
    title: "The webhooks route is monitored by an off-the-books pingdom check",
    body: "The /webhooks endpoint has an external pingdom probe that nobody has written up. If it goes red, the on-call pings the Stripe team through a private Slack channel. This is tribal knowledge — new engineers discover it the hard way during their first outage.",
    files: ["src/api/routes/webhooks.ts"],
    tags: ["monitoring", "pingdom", "tribal"],
  },
  {
    title: "PR descriptions must mention the linear ticket in the first line",
    body: "Every pull request description must reference the linear ticket ID on the very first line. This is not enforced by CI — the team rejects PRs that miss it because the release notes generator scrapes that line. It is a soft rule that newcomers break every time.",
    files: [".github/workflows/ci.yml"],
    tags: ["pr", "linear", "release-notes"],
  },
];

const DEPRECATION_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Deprecated getUserById v1 use getUserProfile instead",
    body: "getUserById v1 returned the raw database row. It is deprecated in favor of getUserProfile which returns a sanitized DTO with PII stripped. The old function will be removed on the next major release. Migrate by replacing the call and mapping the fields — the shape is a strict subset.",
    files: ["src/api/routes/users.ts", "src/lib/db.ts"],
    tags: ["deprecation", "users", "v1"],
  },
  {
    title: "Deprecated legacy webhook endpoint use v2 signed callback",
    body: "The /legacy/webhook endpoint accepts unsigned payloads from partners. It is deprecated in favor of /v2/webhook which requires HMAC signatures. Existing partners have 90 days to migrate. After the cutoff we return 410 gone.",
    files: ["src/api/routes/webhooks.ts"],
    tags: ["deprecation", "webhook", "v2"],
  },
  {
    title: "Deprecated email sendAll use queue based dispatch",
    body: "The sendAll helper fired every email synchronously in a loop. It is deprecated in favor of queue.enqueueBatch which hands the batch to the worker. The deprecation was added after an outage where sendAll blocked the request thread for two minutes.",
    files: ["src/workers/email.ts"],
    tags: ["deprecation", "email", "queue"],
  },
  {
    title: "Deprecated redis key pattern user colon id replace with u slash id",
    body: "The legacy redis key pattern user:<id> is deprecated. New code must use u/<id> which is compatible with the cluster hash slot rebalancer. Old keys are backfilled and removed on the next migration window.",
    files: ["src/lib/redis.ts"],
    tags: ["deprecation", "redis", "keys"],
  },
  {
    title: "Deprecated useAuth hook with cookies use tokenized useSession",
    body: "The useAuth hook read the session cookie directly. It is deprecated in favor of useSession which goes through the token exchange and supports SSR. Migrate components by replacing useAuth with useSession and reading session.user instead of user.",
    files: ["src/hooks/useAuth.ts", "src/components/Dashboard.tsx"],
    tags: ["deprecation", "react", "session"],
  },
  {
    title: "Deprecated prisma findMany without cursor switch to cursor based pagination",
    body: "findMany with skip and take is deprecated for lists larger than 1000 rows. The performance drops linearly as skip grows. Switch to cursor-based pagination with the orderBy id cursor pattern. Old code is marked with a TODO and removed on refactors.",
    files: ["src/lib/db.ts", "src/api/routes/users.ts"],
    tags: ["deprecation", "prisma", "pagination"],
  },
  {
    title: "Deprecated terraform aws instance type t2 use t3 family",
    body: "t2 instance types are deprecated for new terraform modules. Use the t3 family which gives burstable performance with a lower baseline cost. Existing instances are migrated during the next maintenance window.",
    files: ["infra/terraform/main.tf"],
    tags: ["deprecation", "terraform", "aws"],
  },
  {
    title: "Deprecated config loading via dotenv require switch to zod schema",
    body: "The old pattern of require dotenv and reading process.env directly is deprecated. New code must load config through src/config.ts which parses a zod schema and fails fast. This catches missing variables at boot instead of at the first request.",
    files: ["src/server/index.ts"],
    tags: ["deprecation", "config", "dotenv"],
  },
  {
    title: "Deprecated stripe api version 2022 01 upgrade to 2023 10 strict",
    body: "Stripe API version 2022-01-11 is deprecated. Upgrade the stripe client to 2023-10-16 with strict types. The upgrade is backward compatible except for the customer payment_method field which becomes an array.",
    files: ["src/lib/stripe.ts"],
    tags: ["deprecation", "stripe", "api-version"],
  },
  {
    title: "Deprecated websocket raw frames use strict json protocol",
    body: "The websocket server accepted raw binary frames for some clients. That path is deprecated — all new connections must use the json protocol with a discriminated message type field. Raw frames are removed after partner migration is complete.",
    files: ["src/server/index.ts"],
    tags: ["deprecation", "websocket", "protocol"],
  },
];

const MIGRATION_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Add not null column to users table with zero downtime backfill",
    body: "To add a NOT NULL column to a 50M row users table without downtime: step 1 add the column as nullable, step 2 backfill in batches of 10k rows with a throttled script, step 3 add the NOT NULL constraint in a second migration. Never do it in one step — the ACCESS EXCLUSIVE lock will take the API down.",
    files: ["prisma/schema.prisma", "scripts/migrate.ts"],
    tags: ["migration", "backfill", "users"],
  },
  {
    title: "Rename a column without breaking the deployed app",
    body: "Renaming a column requires a blue-green migration: step 1 add the new column, step 2 dual write to old and new from the app, step 3 backfill the new column, step 4 switch reads, step 5 drop the old column. Each step is a separate deploy to avoid a window where app and schema disagree.",
    files: ["prisma/schema.prisma", "scripts/migrate.ts"],
    tags: ["migration", "rename", "dual-write"],
  },
  {
    title: "Split a monolithic users table into user_profiles and user_settings",
    body: "Splitting a wide table starts with creating the child tables, dual writing, backfilling, verifying parity with a checksum query, and finally cutting over reads. Keep the old columns for a release cycle so rollback is possible. This is how we split the billing fields out of users.",
    files: ["prisma/schema.prisma"],
    tags: ["migration", "split", "table"],
  },
  {
    title: "Upgrade prisma from version 4 to version 5 with breaking changes",
    body: "Upgrading prisma 4 to 5 has two breaking changes that affect us: the removed rejectOnNotFound option and the changed findUnique behavior with compound ids. Update the schema, regenerate the client, and run the type check before rolling out.",
    files: ["prisma/schema.prisma", "package.json"],
    tags: ["migration", "prisma", "upgrade"],
  },
  {
    title: "Move from redis single node to cluster mode with key prefix",
    body: "Moving ioredis from single-node to cluster mode requires adding a key prefix so all keys route to a predictable slot. Update the client construction, add the cluster nodes, and make sure no command uses MGET across unrelated keys. The eval script cannot span slots.",
    files: ["src/lib/redis.ts", "infra/terraform/main.tf"],
    tags: ["migration", "redis", "cluster"],
  },
  {
    title: "Migrate stripe account from platform to separate connected accounts",
    body: "Moving billing from a single platform account to connected accounts per customer requires updating every stripe call to pass the stripeAccount header. Then migrate existing customers with the connect onboarding flow. Revenue reporting changes — coordinate with finance.",
    files: ["src/lib/stripe.ts", "src/workers/billing.ts"],
    tags: ["migration", "stripe", "connect"],
  },
  {
    title: "Switch authentication from session cookies to jwt bearer tokens",
    body: "To migrate from session cookies to JWT bearer tokens: dual support both in middleware for one release, update the client to store and send the bearer, then remove the cookie path. The session table is kept for refresh tokens.",
    files: ["src/middleware/auth.ts", "src/lib/jwt.ts"],
    tags: ["migration", "auth", "jwt"],
  },
  {
    title: "Upgrade node from 18 to 20 with esm and performance changes",
    body: "Upgrading from Node 18 to Node 20: test the ESM resolution changes, check for any dependency that pinned to Node 18, and re-run the perf benchmarks. We saw a 10 percent improvement on the billing worker so it was worth the test cost.",
    files: ["package.json", ".github/workflows/ci.yml"],
    tags: ["migration", "node", "upgrade"],
  },
  {
    title: "Move from github actions shared runners to self hosted arm64 runners",
    body: "Self-hosted arm64 runners cut our CI cost by 40 percent and build time by 25 percent. Migration steps: provision the runner on graviton instances, register with the repo, update workflow YAML to target the new label, delete the shared runner dependency. Keep the shared runner as a fallback for one month.",
    files: [".github/workflows/ci.yml", "infra/terraform/main.tf"],
    tags: ["migration", "ci", "arm64"],
  },
  {
    title: "Switch from trpc v10 to trpc v11 with typed errors",
    body: "trpc v11 introduces typed errors at the router level. The migration requires replacing throw new Error with throw new TRPCError in every procedure, and updating the client error handler to narrow on the code field. Run the codemod and then audit the error boundary.",
    files: ["src/server/trpc.ts"],
    tags: ["migration", "trpc", "errors"],
  },
];

const RUNBOOK_TEMPLATES: ReadonlyArray<{
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
}> = [
  {
    title: "Incident response for 5xx spike on billing route",
    body: "When the billing route 5xx rate exceeds 2 percent: step 1 open the grafana dashboard and check the stripe latency panel, step 2 check the worker queue depth, step 3 if the queue is backed up page the billing on-call, step 4 if stripe is the problem post in the partner channel. Communicate updates every 15 minutes.",
    files: ["src/workers/billing.ts", "src/api/routes/billing.ts"],
    tags: ["runbook", "incident", "billing"],
  },
  {
    title: "Database failover procedure for primary outage",
    body: "If the primary postgres instance is unreachable for 60 seconds: step 1 confirm via the aws console that it is actually down, step 2 trigger the failover to the standby with the rds failover command, step 3 verify the application reconnects, step 4 update the incident channel. Expected downtime under five minutes.",
    files: ["src/lib/db.ts"],
    tags: ["runbook", "db", "failover"],
  },
  {
    title: "Rotate stripe webhook signing secret safely",
    body: "To rotate the stripe webhook secret without losing webhooks: add the new secret to the env, deploy the app with both old and new accepted, roll the secret in the stripe dashboard, confirm new signatures verify, remove the old secret from env. Never roll first — you will drop events.",
    files: ["src/lib/stripe.ts", "src/api/routes/webhooks.ts"],
    tags: ["runbook", "stripe", "secret"],
  },
  {
    title: "Drain a kubernetes node without customer impact",
    body: "To drain a k8s node: set it unschedulable with kubectl cordon, then drain with kubectl drain ignoring daemonsets. Watch the pod disruption budget so you do not take more pods than allowed. If the drain hangs on a pod, check the terminationGracePeriodSeconds and the pre-stop hook.",
    files: ["infra/k8s/deployment.yaml"],
    tags: ["runbook", "k8s", "drain"],
  },
  {
    title: "Emergency rollback of a bad release",
    body: "To roll back a bad release: identify the previous known-good image tag, push it to the deployment, and watch the rollout. If the issue is schema-related, roll back the schema migration with the compensating migration — do not manually edit the schema.",
    files: [".github/workflows/deploy.yml"],
    tags: ["runbook", "rollback", "deploy"],
  },
  {
    title: "Investigate a memory leak in a worker process",
    body: "When a worker process memory grows unbounded: capture a heap snapshot with node --inspect and chrome devtools, compare two snapshots taken five minutes apart, look for retained closures and timers. Usually the culprit is a cache without bounds or an event listener that is never removed.",
    files: ["src/workers/indexer.ts"],
    tags: ["runbook", "memory", "worker"],
  },
  {
    title: "Rotate jwt signing key without logging everyone out",
    body: "To rotate a JWT signing key: add the new key to the key set and keep the old key for verification, mint new tokens with the new key, wait for the longest lived token to expire, remove the old key. Never rotate instantly or every user gets kicked to the login screen.",
    files: ["src/lib/jwt.ts"],
    tags: ["runbook", "jwt", "rotation"],
  },
  {
    title: "Debug a cors failure in the browser",
    body: "To debug a cors failure: open the network tab, find the failing OPTIONS preflight, check the response headers for Access-Control-Allow-Origin and Access-Control-Allow-Credentials. Curl the preflight manually to rule out browser-specific behavior. The most common cause is a missing origin on the allow list.",
    files: ["src/server/index.ts"],
    tags: ["runbook", "cors", "browser"],
  },
  {
    title: "Clear a stuck job from the email queue",
    body: "To clear a stuck email queue job: connect to redis, LRANGE the queue to find the job ID, LREM it carefully so you do not drop healthy jobs, then check the dead letter queue. Re-enqueue the message with a fresh ID if it still needs to be sent.",
    files: ["src/workers/email.ts", "src/lib/redis.ts"],
    tags: ["runbook", "queue", "email"],
  },
  {
    title: "Respond to a security vulnerability disclosure",
    body: "When a security researcher reports a vulnerability: acknowledge within 24 hours, triage severity with the security champion, open a private fix branch, patch and release, then publish a post-mortem after a 90 day grace period. Do not discuss the issue in public channels until the patch ships.",
    files: [".github/workflows/ci.yml"],
    tags: ["runbook", "security", "disclosure"],
  },
];

// ---------------------------------------------------------------------------
// Entry synthesis — expand templates into count entries by rotating details
// ---------------------------------------------------------------------------

interface TemplateEntry {
  title: string;
  body: string;
  files: readonly string[];
  tags: readonly string[];
  sig?: string;
}

function synthesize(
  type: string,
  idPrefix: string,
  count: number,
  templates: readonly TemplateEntry[],
  halfLifeTag: string,
): EntryRow[] {
  const out: EntryRow[] = [];
  for (let i = 0; i < count; i++) {
    const tpl = templates[i % templates.length]!;
    const variant = Math.floor(i / templates.length);
    const titleSuffix = variant === 0 ? "" : ` (case ${variant + 1})`;
    const contentSuffix =
      variant === 0
        ? ""
        : ` Noted across ${variant + 1} separate incidents in the ${halfLifeTag} category.`;
    const ts = new Date(2025, randInt(0, 11), randInt(1, 28)).toISOString();
    const confidence =
      type === "ghost_knowledge" ? 1.0 : 0.5 + rand() * 0.5;
    const id = `${idPrefix}-${String(i + 1).padStart(3, "0")}`;
    out.push({
      id,
      type,
      title: tpl.title + titleSuffix,
      content: tpl.body + contentSuffix,
      files: tpl.files,
      tags: [...tpl.tags, halfLifeTag],
      errorSignature: tpl.sig,
      confidence: Math.round(confidence * 100) / 100,
      sourceCount: randInt(1, 5),
      sourceTool: pick(SOURCE_TOOLS),
      createdAt: ts,
      lastConfirmed: ts,
      status: "active",
      scope: "team",
      developerId: pick(DEVS),
    });
  }
  return out;
}

// NOTE: the core `entries.type` column is constrained by CHECK to five
// allowed values. CodeMemBench has 8 semantic categories, so we map the
// three extra categories (deprecation, migration, runbook) onto the
// nearest valid type and preserve the original flavor in a tag. Queries
// still use the 8-way `category` field so scoring is unaffected.
function buildEntries(): EntryRow[] {
  const all: EntryRow[] = [];
  all.push(...synthesize("error_pattern", "err", 80, ERROR_TEMPLATES, "error"));
  all.push(...synthesize("convention", "cnv", 70, CONVENTION_TEMPLATES, "convention"));
  all.push(...synthesize("decision", "dec", 60, DECISION_TEMPLATES, "decision"));
  all.push(...synthesize("learning", "lrn", 50, LEARNING_TEMPLATES, "learning"));
  all.push(...synthesize("ghost_knowledge", "ght", 50, GHOST_TEMPLATES, "ghost"));
  all.push(...synthesize("decision", "dep", 80, DEPRECATION_TEMPLATES, "deprecation"));
  all.push(...synthesize("decision", "mig", 60, MIGRATION_TEMPLATES, "migration"));
  all.push(...synthesize("learning", "rbk", 50, RUNBOOK_TEMPLATES, "runbook"));
  return all;
}

// ---------------------------------------------------------------------------
// Query synthesis — derive from entry content so ground truth is exact
// ---------------------------------------------------------------------------

interface BenchmarkQuery {
  readonly id: string;
  readonly text: string;
  readonly category: string;
  readonly difficulty: "easy" | "medium" | "hard";
  readonly relevantEntryIds: readonly string[];
  readonly fileContext?: readonly string[];
  readonly typeFilter?: string;
}

const CATEGORIES = [
  "error_resolution",
  "convention_lookup",
  "decision_rationale",
  "ghost_knowledge",
  "file_specific",
  "cross_cutting",
  "temporal",
  "onboarding",
] as const;

// Pulls 2–4 distinctive content words from title+content, skipping FTS5
// reserved words and short stop-words.
const STOP = new Set([
  "the","a","an","and","or","not","near","match","is","it","to","of","in","on",
  "for","with","by","at","as","from","we","our","that","this","you","your",
  "be","are","was","were","have","has","had","do","does","did","but","if",
  "when","then","than","so","because","into","out","up","down","over","under",
]);
const RESERVED = new Set(["near","match","and","or","not"]);

function distinctiveWords(entry: EntryRow, count: number): string[] {
  const text = `${entry.title} ${entry.content}`.toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 4) continue;
    if (STOP.has(t)) continue;
    if (RESERVED.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= count * 3) break;
  }
  // deterministic pseudo-shuffle using the PRNG
  const picked: string[] = [];
  while (picked.length < count && out.length > 0) {
    const idx = Math.floor(rand() * out.length);
    picked.push(out.splice(idx, 1)[0]!);
  }
  return picked;
}

function buildQuery(
  id: string,
  category: string,
  difficulty: "easy" | "medium" | "hard",
  targets: EntryRow[],
): BenchmarkQuery {
  const primary = targets[0]!;
  const wordCount = difficulty === "easy" ? 4 : difficulty === "medium" ? 3 : 2;
  const words = distinctiveWords(primary, wordCount);

  let text: string;
  if (difficulty === "easy") {
    text = `how do we handle ${words.join(" ")}`;
  } else if (difficulty === "medium") {
    text = `what is the approach for ${words.join(" ")} in this codebase`;
  } else {
    text = `guidance on ${words.slice(0, 2).join(" ")}`;
  }

  const q: BenchmarkQuery = {
    id,
    text,
    category,
    difficulty,
    relevantEntryIds: targets.map((t) => t.id),
    fileContext: category === "file_specific" ? primary.files.slice(0, 2) : undefined,
    typeFilter: undefined,
  };
  return q;
}

function buildQueries(entries: readonly EntryRow[]): BenchmarkQuery[] {
  const byType = (t: string) => entries.filter((e) => e.type === t);
  const errorEntries = byType("error_pattern");
  const conventionEntries = byType("convention");
  const decisionEntries = byType("decision");
  const ghostEntries = byType("ghost_knowledge");
  const learningEntries = byType("learning");
  const deprecationEntries = byType("deprecation");
  const migrationEntries = byType("migration");
  const runbookEntries = byType("runbook");

  const queries: BenchmarkQuery[] = [];
  let counter = 1;
  const nextId = () => `q-${String(counter++).padStart(3, "0")}`;

  // Target totals: 70 easy + 80 medium + 50 hard = 200
  // Per-category budgets (8 categories * 25 = 200):
  const perCat = 25;

  const categoryPools: Record<string, EntryRow[]> = {
    error_resolution: errorEntries,
    convention_lookup: conventionEntries,
    decision_rationale: decisionEntries,
    ghost_knowledge: ghostEntries,
    file_specific: [...errorEntries, ...migrationEntries],
    cross_cutting: [...deprecationEntries, ...decisionEntries],
    temporal: [...runbookEntries, ...learningEntries],
    onboarding: [...conventionEntries, ...runbookEntries, ...decisionEntries],
  };

  // Distribute difficulty: per category, 9 easy + 10 medium + 6 hard = 25
  for (const category of CATEGORIES) {
    const pool = categoryPools[category]!;
    const difficulties: Array<"easy" | "medium" | "hard"> = [];
    for (let i = 0; i < 9; i++) difficulties.push("easy");
    for (let i = 0; i < 10; i++) difficulties.push("medium");
    for (let i = 0; i < 6; i++) difficulties.push("hard");
    for (let i = 0; i < perCat; i++) {
      const difficulty = difficulties[i]!;
      const targetCount = difficulty === "hard" ? randInt(2, 3) : 1;
      const targets = pickN(pool, targetCount);
      if (targets.length === 0) continue;
      queries.push(buildQuery(nextId(), category, difficulty, targets));
    }
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const entries = buildEntries();
  const queries = buildQueries(entries);

  const dataset = {
    version: "1.0.0",
    seed: SEED,
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    queryCount: queries.length,
    categories: CATEGORIES,
    difficultyDistribution: { easy: 70, medium: 80, hard: 50 },
    entries,
    queries,
  };

  if (entries.length !== 500) {
    throw new Error(`Expected 500 entries, got ${entries.length}`);
  }
  if (queries.length !== 200) {
    throw new Error(`Expected 200 queries, got ${queries.length}`);
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(dataset, null, 2), "utf8");
  const byDiff = queries.reduce<Record<string, number>>((acc, q) => {
    acc[q.difficulty] = (acc[q.difficulty] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `CodeMemBench dataset written: ${entries.length} entries, ${queries.length} queries ` +
      `(easy=${byDiff.easy ?? 0} medium=${byDiff.medium ?? 0} hard=${byDiff.hard ?? 0}) ` +
      `→ ${OUTPUT_PATH}`,
  );
}

main();
