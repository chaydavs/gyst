# Universal Capture + Curated Knowledge Pipeline — Phase 1 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the hook-coverage holes across every AI agent, capture a unified event stream into the existing `event_queue` outbox, add a rule-based parser that promotes high-signal events into curated `entries`, and surface a session recap.

**Architecture:** Two-channel capture — plugin hooks where available (Claude Code, Codex, Gemini) plus MCP dispatcher instrumentation as a universal fallback (covers Cursor / Windsurf / OpenCode / Continue which have no hook system). Events land in `event_queue` (raw log, purgeable). A new rule-based classifier tags each event with signal strength + scope hint. A consumer batches high-signal events into curated `entries` (the durable wiki artifact). Personal/team split leverages the already-existing `entries.scope` and `entries.developer_id` columns. LLM distillation (Phase 2) and dashboard UI (Phase 3) are out of scope for this plan.

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, @modelcontextprotocol/sdk, zod, commander, bun:test.

**Deferred to follow-up plans:**
- Phase 2 — LLM distillation over classifier-flagged batches
- Phase 3 — dashboard UI with personal/team split views
- Phase 4 — Turso team sync

---

## File Structure

**Modify:**
- `src/cli/install.ts` — extend `mergeClaudeHooks` for 3 missing events; fix `writeHooksPlugin` scriptsDir resolution for installed builds.
- `src/mcp/register-tools.ts` — wrap `server.tool()` to auto-emit `tool_use` events on every MCP call.
- `src/store/database.ts` — add `sessions` table creation + idempotent `session_id` migration on `event_queue`.
- `src/store/events.ts` — accept optional `sessionId`; emit into new column.
- `src/cli/index.ts` — register new `recap` command.

**Create:**
- `src/compiler/classify-event.ts` — pure rule-based event classifier.
- `src/compiler/process-events.ts` — queue consumer; reads pending events, classifies, writes entries.
- `src/cli/recap.ts` — `gyst recap` command handler.
- `tests/cli/install-claude-hooks.test.ts` — extends existing install tests.
- `tests/mcp/dispatcher-instrument.test.ts` — confirms tool_use events emit on MCP call.
- `tests/store/sessions-schema.test.ts` — verifies migration is idempotent.
- `tests/compiler/classify-event.test.ts` — rule coverage.
- `tests/compiler/process-events.test.ts` — consumer integration.
- `tests/cli/recap.test.ts` — recap output shape.

## Parallel Dispatch Map

These six tasks touch disjoint files and may be run concurrently by independent subagents:

| Agent | Task | Primary file |
|---|---|---|
| A | Task 1 (Claude+Codex hooks) | `src/cli/install.ts` |
| B | Task 2 (MCP dispatcher) | `src/mcp/register-tools.ts` |
| C | Task 3 (Sessions schema) | `src/store/database.ts` + `src/store/events.ts` |
| D | Task 4 (Rule classifier) | `src/compiler/classify-event.ts` |
| E | Task 5 (Queue consumer) | `src/compiler/process-events.ts` |
| F | Task 6 (Recap CLI) | `src/cli/recap.ts` + `src/cli/index.ts` |

Agents E and F rely on interface contracts locked by Agents C + D — they MUST read the test files those agents write to stay type-aligned. The reviewer gates Task 5 and Task 6 merges until Tasks 3 and 4 are green.

---

## Task 1 — Claude Code hook wiring (Agent A)

**Files:**
- Modify: `src/cli/install.ts:228-270` (`mergeClaudeHooks`) and `src/cli/install.ts:185-200` (`writeHooksPlugin`)
- Test: `tests/cli/install.test.ts` (extend existing)

- [ ] **Step 1: Write failing test for UserPromptSubmit merge**

Add to `tests/cli/install.test.ts`:

```typescript
test("mergeClaudeHooks registers UserPromptSubmit", () => {
  const merged = mergeClaudeHooks({}) as any;
  expect(merged.hooks.UserPromptSubmit).toBeDefined();
  expect(merged.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
    "gyst emit prompt 2>/dev/null || true"
  );
});

test("mergeClaudeHooks registers PostToolUse", () => {
  const merged = mergeClaudeHooks({}) as any;
  expect(merged.hooks.PostToolUse).toBeDefined();
  expect(merged.hooks.PostToolUse[0].matcher).toBe("*");
  expect(merged.hooks.PostToolUse[0].hooks[0].command).toBe(
    "gyst emit tool_use 2>/dev/null || true"
  );
});

test("mergeClaudeHooks registers Stop", () => {
  const merged = mergeClaudeHooks({}) as any;
  expect(merged.hooks.Stop).toBeDefined();
  expect(merged.hooks.Stop[0].hooks[0].command).toBe(
    "gyst emit session_end 2>/dev/null || true"
  );
});

test("mergeClaudeHooks replaces prior gyst entries without touching others", () => {
  const existing = {
    hooks: {
      UserPromptSubmit: [
        { matcher: "*", hooks: [{ type: "command", command: "claude-mem hook" }] },
        { matcher: "*", hooks: [{ type: "command", command: "gyst emit prompt 2>/dev/null || true" }] },
      ],
    },
  };
  const merged = mergeClaudeHooks(existing) as any;
  const commands = merged.hooks.UserPromptSubmit.flatMap((h: any) =>
    h.hooks.map((x: any) => x.command)
  );
  expect(commands).toContain("claude-mem hook");
  expect(commands.filter((c: string) => c.startsWith("gyst ")).length).toBe(1);
});
```

- [ ] **Step 2: Run test, confirm failure**

Run: `bun test tests/cli/install.test.ts`
Expected: 3–4 failures (new events not registered).

- [ ] **Step 3: Extend `mergeClaudeHooks` implementation**

Replace the function body at `src/cli/install.ts:228-270` with:

```typescript
export function mergeClaudeHooks(config: McpConfig): McpConfig {
  type HookEntry = { matcher: string; hooks: { type: string; command: string }[] };

  const isGystHook = (h: HookEntry): boolean =>
    h.hooks.some((cmd) => cmd.command.startsWith("gyst "));

  const gystSessionStart: HookEntry = {
    matcher: "auto",
    hooks: [
      { type: "command", command: "gyst emit session_start 2>/dev/null || true" },
      { type: "command", command: "gyst inject-context --always-on --graph-traverse" },
    ],
  };
  const gystPreCompact: HookEntry = {
    matcher: "auto",
    hooks: [{ type: "command", command: "gyst emit pre_compact 2>/dev/null || true" }],
  };
  const gystPrompt: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit prompt 2>/dev/null || true" }],
  };
  const gystToolUse: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit tool_use 2>/dev/null || true" }],
  };
  const gystStop: HookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: "gyst emit session_end 2>/dev/null || true" }],
  };

  const existingHooks =
    typeof config.hooks === "object" && config.hooks !== null
      ? (config.hooks as Record<string, HookEntry[]>)
      : {};

  const merge = (existing: HookEntry[] | undefined, toAdd: HookEntry): HookEntry[] => [
    ...(existing ?? []).filter((h) => !isGystHook(h)),
    toAdd,
  ];

  return {
    ...config,
    hooks: {
      ...existingHooks,
      SessionStart: merge(existingHooks["SessionStart"], gystSessionStart),
      PreCompact: merge(existingHooks["PreCompact"], gystPreCompact),
      UserPromptSubmit: merge(existingHooks["UserPromptSubmit"], gystPrompt),
      PostToolUse: merge(existingHooks["PostToolUse"], gystToolUse),
      Stop: merge(existingHooks["Stop"], gystStop),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/cli/install.test.ts`
Expected: all tests green.

- [ ] **Step 5: Fix Codex broken-paths bug in `writeHooksPlugin`**

At `src/cli/install.ts:185-200`, replace:

```typescript
function writeHooksPlugin(targetDir: string): void {
  // Resolve scripts dir robustly regardless of dev vs. installed build layout.
  // In dev:     src/cli/install.ts      → ../../plugin/scripts
  // In dist:    dist/cli.js (bundled)   → ../plugin/scripts
  // In npm pkg: dist/cli/install.js     → ../../plugin/scripts
  // Try each candidate; use the first that exists.
  const here = import.meta.dir;
  const candidates = [
    join(here, "..", "..", "plugin", "scripts"),
    join(here, "..", "plugin", "scripts"),
    join(here, "plugin", "scripts"),
  ];
  const scriptsDir = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  const hooksConfig = {
    hooks: [
      { event: "SessionStart", script: join(scriptsDir, "session-start.js"), timeout: 5000 },
      { event: "UserPromptSubmit", script: join(scriptsDir, "prompt.js"), timeout: 2000 },
      { event: "PostToolUse", matcher: "", script: join(scriptsDir, "tool-use.js"), timeout: 2000 },
      { event: "Stop", script: join(scriptsDir, "session-end.js"), timeout: 5000 },
    ],
  };
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "hooks.json"), JSON.stringify(hooksConfig, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 6: Add test for broken-paths fix**

Append to `tests/cli/install.test.ts`:

```typescript
test("writeHooksPlugin resolves scripts dir relative to module", async () => {
  const { writeHooksPlugin } = await import("../../src/cli/install.js") as any;
  const tmp = join(tmpdir(), `gyst-plugin-${Date.now()}`);
  writeHooksPlugin(tmp);
  const contents = JSON.parse(readFileSync(join(tmp, "hooks.json"), "utf-8"));
  for (const h of contents.hooks) {
    expect(h.script).toContain("plugin/scripts");
    expect(h.script.startsWith("/")).toBe(true);
  }
});
```

- [ ] **Step 7: Run all install tests**

Run: `bun test tests/cli/install.test.ts`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/cli/install.ts tests/cli/install.test.ts
git commit -m "feat(install): wire UserPromptSubmit/PostToolUse/Stop hooks and fix Codex scriptsDir resolution"
```

---

## Task 2 — MCP dispatcher tool_use instrumentation (Agent B)

**Files:**
- Modify: `src/mcp/register-tools.ts:72-95` (`registerAllTools`)
- Create: `tests/mcp/dispatcher-instrument.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/mcp/dispatcher-instrument.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initDatabase } from "../../src/store/database.js";
import { registerAllTools } from "../../src/mcp/register-tools.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

test("MCP tool_use event is emitted on each tool call", async () => {
  const server = new McpServer({ name: "gyst", version: "test" });
  registerAllTools(server, { mode: "personal", db });

  // Invoke the status tool through the registered handler directly.
  const internals = server as unknown as { _registeredTools: Record<string, { callback: (args: unknown) => Promise<unknown> }> };
  await internals._registeredTools.status.callback({});

  const events = db
    .query<{ type: string; payload: string }, []>(
      "SELECT type, payload FROM event_queue WHERE type = 'tool_use' ORDER BY id DESC"
    )
    .all();
  expect(events.length).toBeGreaterThanOrEqual(1);
  const payload = JSON.parse(events[0]!.payload);
  expect(payload.tool).toBe("status");
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test tests/mcp/dispatcher-instrument.test.ts`
Expected: zero events in event_queue (before instrumentation).

- [ ] **Step 3: Implement instrumentation wrapper**

At the top of `src/mcp/register-tools.ts` (after imports), add:

```typescript
import { emitEvent, type EventType } from "../store/events.js";

/**
 * Wraps McpServer.tool() so every registered handler also records a
 * `tool_use` event into event_queue after invocation. Non-blocking —
 * emission failures are swallowed to keep tool latency flat.
 */
function instrumentServer(server: McpServer, db: Database): void {
  const original = server.tool.bind(server) as typeof server.tool;
  // @ts-expect-error — re-typing the method to preserve all overload shapes.
  server.tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const cb = last as (...cbArgs: unknown[]) => Promise<unknown> | unknown;
      const wrapped = async (...cbArgs: unknown[]) => {
        try {
          return await cb(...cbArgs);
        } finally {
          try {
            emitEvent(db, "tool_use" as EventType, {
              tool: name,
              args: cbArgs[0] ?? {},
              ts: Date.now(),
            });
          } catch {
            // fire-and-forget
          }
        }
      };
      args[args.length - 1] = wrapped;
    }
    // @ts-expect-error — pass-through
    return original(...args);
  };
}
```

Then at the top of `registerAllTools` (before the first `registerLearnTool` call), add:

```typescript
instrumentServer(server, ctx.db);
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test tests/mcp/dispatcher-instrument.test.ts`
Expected: pass. `tool_use` event in queue with `payload.tool === 'status'`.

- [ ] **Step 5: Run full MCP test suite to ensure no regressions**

Run: `bun test tests/mcp/`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/register-tools.ts tests/mcp/dispatcher-instrument.test.ts
git commit -m "feat(mcp): auto-emit tool_use events on every MCP tool call"
```

---

## Task 3 — Sessions schema + event session_id (Agent C)

**Files:**
- Modify: `src/store/database.ts` (schema section ~line 107, migration block ~line 300)
- Modify: `src/store/events.ts`
- Create: `tests/store/sessions-schema.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/store/sessions-schema.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { initDatabase } from "../../src/store/database.js";
import { emitEvent } from "../../src/store/events.js";

test("sessions table exists with expected columns", () => {
  const db = initDatabase(":memory:");
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
  const names = cols.map((c) => c.name);
  expect(names).toContain("id");
  expect(names).toContain("agent");
  expect(names).toContain("developer_id");
  expect(names).toContain("started_at");
  expect(names).toContain("ended_at");
  db.close();
});

test("event_queue.session_id column exists", () => {
  const db = initDatabase(":memory:");
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(event_queue)").all();
  expect(cols.map((c) => c.name)).toContain("session_id");
  db.close();
});

test("emitEvent persists session_id when provided", () => {
  const db = initDatabase(":memory:");
  emitEvent(db, "prompt", { sessionId: "sess-123", text: "hello" });
  const row = db
    .query<{ session_id: string | null }, []>(
      "SELECT session_id FROM event_queue ORDER BY id DESC LIMIT 1"
    )
    .get();
  expect(row?.session_id).toBe("sess-123");
  db.close();
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test tests/store/sessions-schema.test.ts`
Expected: 3 failures — no `sessions` table, no `session_id` column.

- [ ] **Step 3: Add sessions table creation**

In `src/store/database.ts` inside the `CREATE TABLE` list (right after the `event_queue` block, before the closing `]`), add:

```typescript
`CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT    NOT NULL PRIMARY KEY,
  agent         TEXT    NOT NULL,
  developer_id  TEXT,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  prompt_count  INTEGER NOT NULL DEFAULT 0,
  tool_count    INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT
)`,
"CREATE INDEX IF NOT EXISTS idx_sessions_dev ON sessions(developer_id, started_at)",
```

- [ ] **Step 4: Add idempotent migration for session_id on event_queue**

In the migration block in `src/store/database.ts` (~line 300), add alongside the existing `ALTER TABLE` calls:

```typescript
try {
  db.run("ALTER TABLE event_queue ADD COLUMN session_id TEXT");
} catch {
  // Column already exists — safe to ignore.
}
try {
  db.run("CREATE INDEX IF NOT EXISTS idx_event_queue_session ON event_queue(session_id)");
} catch {
  // Index exists or table not yet created.
}
```

- [ ] **Step 5: Update `emitEvent` to persist session_id**

Replace `emitEvent` in `src/store/events.ts`:

```typescript
export function emitEvent(
  db: Database,
  type: EventType,
  payload: EventPayload,
): void {
  withRetry(() => {
    db.run(
      "INSERT INTO event_queue (type, payload, session_id) VALUES (?, ?, ?)",
      [type, JSON.stringify(payload), payload.sessionId ?? null],
    );
  }, 3, 50);
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `bun test tests/store/sessions-schema.test.ts`
Expected: all 3 green.

- [ ] **Step 7: Run full store test suite**

Run: `bun test tests/store/`
Expected: all green (no regressions on existing event / entry tests).

- [ ] **Step 8: Commit**

```bash
git add src/store/database.ts src/store/events.ts tests/store/sessions-schema.test.ts
git commit -m "feat(store): add sessions table and session_id on event_queue"
```

---

## Task 4 — Rule-based event classifier (Agent D)

**Files:**
- Create: `src/compiler/classify-event.ts`
- Create: `tests/compiler/classify-event.test.ts`

- [ ] **Step 1: Write failing test with full rule coverage**

Create `tests/compiler/classify-event.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { classifyEvent } from "../../src/compiler/classify-event.js";

test("high-signal convention-like prompt scores >= 0.7 and team scope", () => {
  const r = classifyEvent({ type: "prompt", payload: { text: "we always use camelCase for identifiers" } });
  expect(r.signalStrength).toBeGreaterThanOrEqual(0.7);
  expect(r.scopeHint).toBe("team");
  expect(r.candidateType).toBe("convention");
});

test("low-signal casual prompt scores < 0.3 and personal scope", () => {
  const r = classifyEvent({ type: "prompt", payload: { text: "fix the bug" } });
  expect(r.signalStrength).toBeLessThan(0.3);
  expect(r.scopeHint).toBe("personal");
});

test("decision-phrased prompt is classified decision and team", () => {
  const r = classifyEvent({
    type: "prompt",
    payload: { text: "we decided to use postgres because we need json queries" },
  });
  expect(r.candidateType).toBe("decision");
  expect(r.scopeHint).toBe("team");
});

test("error tool_use event is classified as error_pattern candidate", () => {
  const r = classifyEvent({
    type: "tool_use",
    payload: { tool: "Bash", error: "Error: ENOENT no such file /foo.txt" },
  });
  expect(r.candidateType).toBe("error_pattern");
  expect(r.signalStrength).toBeGreaterThan(0.4);
});

test("session_start event scores 0 signal (boundary marker only)", () => {
  const r = classifyEvent({ type: "session_start", payload: {} });
  expect(r.signalStrength).toBe(0);
  expect(r.candidateType).toBeNull();
});

test("commit event becomes a learning candidate with moderate signal", () => {
  const r = classifyEvent({
    type: "commit",
    payload: { message: "feat(auth): enforce TOTP on admin routes" },
  });
  expect(r.candidateType).toBe("learning");
  expect(r.signalStrength).toBeGreaterThan(0.3);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test tests/compiler/classify-event.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement classifier**

Create `src/compiler/classify-event.ts`:

```typescript
/**
 * Rule-based event classifier (Stage 1 of the parsing pipeline).
 *
 * Takes a raw event row and returns a classification verdict:
 *   - signalStrength:  0..1 — likelihood this event carries durable knowledge
 *   - scopeHint:       'personal' | 'team' | 'uncertain'
 *   - candidateType:   which entry type this event could become, or null
 *
 * Pure function. No I/O. No DB access. Safe for batch processing.
 */

export type EntryType = "convention" | "decision" | "learning" | "error_pattern" | "ghost_knowledge";
export type ScopeHint = "personal" | "team" | "uncertain";

export interface RawEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface Classification {
  readonly signalStrength: number;
  readonly scopeHint: ScopeHint;
  readonly candidateType: EntryType | null;
}

const TEAM_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\b(always|never)\s+(use|write|call|prefer)/i,
  /\bwe (use|prefer|decided|chose|standardi[sz]e)/i,
  /\b(convention|standard|policy|guideline)\b/i,
  /\bmust\s+(be|not|use|follow)/i,
];

const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(we )?(decided|chose|picked|went with|settled on)\b/i,
  /\bbecause\b/i,
  /\brationale\b/i,
];

const CONVENTION_PATTERNS: readonly RegExp[] = [
  /\b(camel|snake|pascal|kebab)[- ]?case\b/i,
  /\bnaming convention\b/i,
  /\b(always|never)\s+(use|write|import|export)\b/i,
];

const ERROR_TOKENS: readonly string[] = [
  "error",
  "exception",
  "failed",
  "traceback",
  "ENOENT",
  "EACCES",
  "segfault",
];

const LOW_SIGNAL_PROMPTS: readonly RegExp[] = [
  /^(ok|okay|yes|no|sure|keep going|continue|proceed|do it|go)\.?$/i,
  /^(fix (the|this)? (bug|issue))\.?$/i,
  /^(try again|retry|run it)\.?$/i,
  /^(thanks?|cool|nice|great)\.?$/i,
];

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

function classifyPrompt(text: string): Classification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
  if (anyMatch(LOW_SIGNAL_PROMPTS, trimmed)) {
    return { signalStrength: 0.1, scopeHint: "personal", candidateType: null };
  }

  const hasTeamSignal = anyMatch(TEAM_SIGNAL_PATTERNS, trimmed);
  const isConvention = anyMatch(CONVENTION_PATTERNS, trimmed);
  const isDecision = anyMatch(DECISION_PATTERNS, trimmed);

  if (isConvention) {
    return { signalStrength: 0.85, scopeHint: "team", candidateType: "convention" };
  }
  if (isDecision && hasTeamSignal) {
    return { signalStrength: 0.8, scopeHint: "team", candidateType: "decision" };
  }
  if (hasTeamSignal) {
    return { signalStrength: 0.7, scopeHint: "team", candidateType: "learning" };
  }
  if (trimmed.length > 80) {
    return { signalStrength: 0.4, scopeHint: "uncertain", candidateType: "learning" };
  }
  return { signalStrength: 0.2, scopeHint: "personal", candidateType: null };
}

function classifyToolUse(payload: Record<string, unknown>): Classification {
  const error = typeof payload.error === "string" ? payload.error : "";
  const hasError =
    error.length > 0 &&
    ERROR_TOKENS.some((t) => error.toLowerCase().includes(t.toLowerCase()));
  if (hasError) {
    return { signalStrength: 0.55, scopeHint: "uncertain", candidateType: "error_pattern" };
  }
  return { signalStrength: 0.1, scopeHint: "personal", candidateType: null };
}

function classifyCommit(payload: Record<string, unknown>): Classification {
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length === 0) {
    return { signalStrength: 0.1, scopeHint: "uncertain", candidateType: null };
  }
  if (/^(chore|style|wip)/i.test(msg)) {
    return { signalStrength: 0.15, scopeHint: "personal", candidateType: null };
  }
  return { signalStrength: 0.45, scopeHint: "team", candidateType: "learning" };
}

/**
 * Classifies a raw event. Never throws.
 */
export function classifyEvent(ev: RawEvent): Classification {
  const payload = ev.payload ?? {};
  switch (ev.type) {
    case "prompt": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return classifyPrompt(text);
    }
    case "tool_use":
      return classifyToolUse(payload);
    case "commit":
      return classifyCommit(payload);
    case "session_start":
    case "session_end":
    case "pre_compact":
    case "pull":
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
    default:
      return { signalStrength: 0, scopeHint: "uncertain", candidateType: null };
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test tests/compiler/classify-event.test.ts`
Expected: all 6 green.

- [ ] **Step 5: Run type check**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/compiler/classify-event.ts tests/compiler/classify-event.test.ts
git commit -m "feat(compiler): rule-based event classifier with scope and type hints"
```

---

## Task 5 — Queue consumer (`process-events.ts`) (Agent E)

**Depends on:** Task 3 (sessions schema) and Task 4 (classifier interface).

**Files:**
- Create: `src/compiler/process-events.ts`
- Create: `tests/compiler/process-events.test.ts`
- Modify: `src/cli/index.ts` — register `gyst process-events` command (optional helper for manual runs)

- [ ] **Step 1: Write failing integration test**

Create `tests/compiler/process-events.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { emitEvent } from "../../src/store/events.js";
import { processEvents } from "../../src/compiler/process-events.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

test("processEvents marks low-signal events completed without writing entries", async () => {
  emitEvent(db, "prompt", { text: "ok keep going" });
  const report = await processEvents(db, { limit: 10 });
  expect(report.processed).toBe(1);
  expect(report.entriesCreated).toBe(0);
  const entries = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM entries").get();
  expect(entries?.c).toBe(0);
  const pending = db.query<{ c: number }, []>(
    "SELECT COUNT(*) as c FROM event_queue WHERE status = 'pending'"
  ).get();
  expect(pending?.c).toBe(0);
});

test("processEvents promotes high-signal convention prompt into a convention entry", async () => {
  emitEvent(db, "prompt", { text: "we always use camelCase for function names", sessionId: "s1" });
  const report = await processEvents(db, { limit: 10 });
  expect(report.entriesCreated).toBe(1);
  const row = db.query<{ type: string; scope: string; title: string }, []>(
    "SELECT type, scope, title FROM entries LIMIT 1"
  ).get();
  expect(row?.type).toBe("convention");
  expect(row?.scope).toBe("team");
  expect(row?.title.length).toBeGreaterThan(0);
});

test("processEvents respects signalThreshold option", async () => {
  emitEvent(db, "prompt", { text: "short medium-signal prompt with more than eighty characters of text so it crosses the length threshold" });
  const high = await processEvents(db, { limit: 10, signalThreshold: 0.9 });
  expect(high.entriesCreated).toBe(0);
});

test("processEvents is safe to run on empty queue", async () => {
  const report = await processEvents(db, { limit: 10 });
  expect(report.processed).toBe(0);
  expect(report.entriesCreated).toBe(0);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test tests/compiler/process-events.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement consumer**

Create `src/compiler/process-events.ts`:

```typescript
/**
 * Stage 1 queue consumer — promotes high-signal events from event_queue
 * into curated `entries`. LLM distillation (Stage 2) is not implemented here
 * and is scoped into a separate plan.
 *
 * Contract:
 *   - Pure bookkeeping: every pending event is marked completed or failed.
 *   - High-signal events (>= threshold) become new entries.
 *   - Low-signal events are discarded (completed, no entry).
 *   - Idempotent per row via event_queue.status transitions.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  getPendingEvents,
  markEventCompleted,
  markEventFailed,
  type EventType,
} from "../store/events.js";
import { classifyEvent, type Classification } from "./classify-event.js";

export interface ProcessOptions {
  readonly limit?: number;
  readonly signalThreshold?: number;
}

export interface ProcessReport {
  readonly processed: number;
  readonly entriesCreated: number;
  readonly skipped: number;
  readonly failed: number;
}

const DEFAULT_THRESHOLD = 0.5;

/**
 * Drains up to `limit` pending events; returns a summary report.
 */
export async function processEvents(
  db: Database,
  options: ProcessOptions = {},
): Promise<ProcessReport> {
  const limit = options.limit ?? 50;
  const threshold = options.signalThreshold ?? DEFAULT_THRESHOLD;

  const rows = getPendingEvents(db, limit);
  let entriesCreated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const verdict = classifyEvent({ type: row.type as string, payload });

      if (verdict.signalStrength >= threshold && verdict.candidateType) {
        createEntryFromEvent(db, row.type, payload, verdict);
        entriesCreated += 1;
      } else {
        skipped += 1;
      }
      markEventCompleted(db, row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("process-events: row failed", { id: row.id, error: msg });
      try {
        markEventFailed(db, row.id, msg);
      } catch {
        // last-resort — don't let bookkeeping failure crash the batch.
      }
      failed += 1;
    }
  }

  return { processed: rows.length, entriesCreated, skipped, failed };
}

function createEntryFromEvent(
  db: Database,
  eventType: EventType | string,
  payload: Record<string, unknown>,
  verdict: Classification,
): void {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scope = verdict.scopeHint === "uncertain" ? "personal" : verdict.scopeHint;

  const title = deriveTitle(eventType, payload);
  const content = deriveContent(eventType, payload);
  const developerId =
    typeof payload.developerId === "string" ? payload.developerId : null;

  db.run(
    `INSERT INTO entries
       (id, type, title, content, confidence, source_count, source_tool,
        created_at, last_confirmed, status, scope, developer_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      verdict.candidateType!,
      title,
      content,
      verdict.signalStrength,
      `event:${eventType}`,
      now,
      now,
      scope,
      developerId,
    ],
  );
}

function deriveTitle(eventType: string, payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  const msg = typeof payload.message === "string" ? payload.message : "";
  const raw = text || msg || `${eventType} event`;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 97)}...`;
}

function deriveContent(eventType: string, payload: Record<string, unknown>): string {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (text.length > 0) return text;
  const msg = typeof payload.message === "string" ? payload.message : "";
  if (msg.length > 0) return msg;
  return JSON.stringify(payload);
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun test tests/compiler/process-events.test.ts`
Expected: all 4 green.

- [ ] **Step 5: Register CLI command (optional, for manual runs)**

In `src/cli/index.ts`, add an import near the top:

```typescript
import { processEvents } from "../compiler/process-events.js";
```

And inside the command registration section (near the `emit` command at line 315), add:

```typescript
program
  .command("process-events")
  .description("Drain pending events from the queue and promote high-signal ones into entries")
  .option("--limit <n>", "max events per run", "50")
  .option("--threshold <n>", "signal threshold 0..1", "0.5")
  .action(async (opts) => {
    const { loadConfig } = await import("../utils/config.js");
    const { initDatabase } = await import("../store/database.js");
    const db = initDatabase(loadConfig().dbPath);
    const report = await processEvents(db, {
      limit: parseInt(opts.limit, 10),
      signalThreshold: parseFloat(opts.threshold),
    });
    db.close();
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  });
```

- [ ] **Step 6: Run full suite**

Run: `bun test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/compiler/process-events.ts src/cli/index.ts tests/compiler/process-events.test.ts
git commit -m "feat(compiler): queue consumer promotes high-signal events into curated entries"
```

---

## Task 6 — `gyst recap` CLI (Agent F)

**Depends on:** Task 3 (sessions table).

**Files:**
- Create: `src/cli/recap.ts`
- Modify: `src/cli/index.ts` — register `recap` command
- Create: `tests/cli/recap.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/cli/recap.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../src/store/database.js";
import { emitEvent } from "../../src/store/events.js";
import { renderRecap } from "../../src/cli/recap.js";

let db: Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

test("renderRecap shows counts per event type for the window", () => {
  emitEvent(db, "prompt", { text: "a" });
  emitEvent(db, "prompt", { text: "b" });
  emitEvent(db, "tool_use", { tool: "learn" });
  emitEvent(db, "commit", { message: "feat: x" });

  const md = renderRecap(db, { sinceMinutes: 60 });
  expect(md).toContain("# Session recap");
  expect(md).toMatch(/Prompts:\s+2/);
  expect(md).toMatch(/Tool calls:\s+1/);
  expect(md).toMatch(/Commits:\s+1/);
});

test("renderRecap returns zeroed summary when no events in window", () => {
  const md = renderRecap(db, { sinceMinutes: 60 });
  expect(md).toContain("Prompts: 0");
  expect(md).toContain("no activity");
});

test("renderRecap lists newly created entries within the window", () => {
  db.run(
    "INSERT INTO entries (id, type, title, content, confidence, source_count, created_at, last_confirmed, status, scope) VALUES ('abc', 'convention', 'Use camelCase', 'body', 0.8, 1, datetime('now'), datetime('now'), 'active', 'team')",
  );
  const md = renderRecap(db, { sinceMinutes: 60 });
  expect(md).toContain("Use camelCase");
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test tests/cli/recap.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement recap module**

Create `src/cli/recap.ts`:

```typescript
/**
 * `gyst recap` — summarise recent activity for a developer.
 *
 * Reads raw events from event_queue + newly-created entries within a
 * time window and renders a markdown summary. Stateless: no writes, no
 * side effects. Intended to be called from a session-end hook.
 */

import type { Database } from "bun:sqlite";

export interface RecapOptions {
  /** How far back to look, in minutes. Default 60. */
  readonly sinceMinutes?: number;
}

interface CountRow {
  type: string;
  c: number;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
}

export function renderRecap(db: Database, options: RecapOptions = {}): string {
  const minutes = options.sinceMinutes ?? 60;
  const cutoff = `-${minutes} minutes`;

  const counts = db
    .query<CountRow, [string]>(
      "SELECT type, COUNT(*) AS c FROM event_queue WHERE created_at >= datetime('now', ?) GROUP BY type",
    )
    .all(cutoff);

  const countOf = (t: string): number => counts.find((r) => r.type === t)?.c ?? 0;

  const entries = db
    .query<EntryRow, [string]>(
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
```

- [ ] **Step 4: Register CLI command**

In `src/cli/index.ts`, add import:

```typescript
import { renderRecap } from "./recap.js";
```

Then inside the commander registration section, add:

```typescript
program
  .command("recap")
  .description("Print a markdown recap of recent activity")
  .option("--since <minutes>", "window size in minutes", "60")
  .action(async (opts) => {
    const { loadConfig } = await import("../utils/config.js");
    const { initDatabase } = await import("../store/database.js");
    const db = initDatabase(loadConfig().dbPath);
    process.stdout.write(renderRecap(db, { sinceMinutes: parseInt(opts.since, 10) }));
    db.close();
  });
```

- [ ] **Step 5: Run test, verify pass**

Run: `bun test tests/cli/recap.test.ts`
Expected: all 3 green.

- [ ] **Step 6: Smoke test the CLI**

Run: `bun run src/cli/index.ts recap --since 10`
Expected: markdown recap printed to stdout, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/recap.ts src/cli/index.ts tests/cli/recap.test.ts
git commit -m "feat(cli): add gyst recap for post-session summary output"
```

---

## Final Integration Step

After all six tasks have merged:

- [ ] Run full suite: `bun test`
- [ ] Run lint: `bun run lint`
- [ ] Run existing CodeMemBench to confirm no recall regression: `bun run benchmark:codememb`
- [ ] Smoke: `gyst emit prompt "always use camelCase"` then `gyst process-events` then `gyst recap` — confirm the convention entry appears in recap.

If all green, cut release notes for the phase and open a follow-up issue for Phase 2 (LLM distillation).

---

## Out of scope — follow-up plans

1. **LLM distillation (Stage 2)** — `docs/superpowers/plans/<date>-llm-distillation.md`. Will batch low/medium-signal events, send to Haiku 4.5, upgrade entries where quality warrants.
2. **Dashboard UI with personal/team split** — `docs/superpowers/plans/<date>-dashboard-scope-split.md`. Two primary views, shared graph canvas.
3. **Turso team sync** — separate plan, gated on Phase 1 + Phase 2 shipping cleanly.
