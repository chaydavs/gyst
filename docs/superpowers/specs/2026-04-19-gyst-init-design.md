# gyst init — Magic One-Command Bootstrap Design

**Goal:** A developer runs `gyst init` in their project and within 90 seconds their AI coding agent is smarter. Zero configuration, zero decisions, zero friction.

**Scope:** This spec covers init orchestration, progressive output rendering, environment detection, and CLI wiring. Context file generation (`.cursorrules`, `AGENTS.md`) is explicitly out of scope — tracked as a separate feature (Prompt 4).

---

## 1. Architecture

Two files change:

| File | Change |
|------|--------|
| `src/cli/commands/init.ts` | New file — all init logic |
| `src/cli/index.ts` | Register `init` command + default no-args action |

`init.ts` has three internal layers:

1. **`detectEnvironment(projectDir)`** — synchronous environment scan, returns a plain `DetectResult` object
2. **`ProgressUI`** — tiny class (~60 lines) for sequential ANSI box output, no external deps
3. **`runInit(opts: InitOptions)`** — orchestrator: detect → KB phases → agent install → summary

---

## 2. Public Interface

```typescript
export interface InitOptions {
  readonly noLlm: boolean;
  readonly noGit: boolean;
  readonly force: boolean;
  readonly projectDir: string;
}

export async function runInit(opts: InitOptions): Promise<void>
```

`runInit` is the only export. Everything else is internal.

---

## 3. Idempotency

At the top of `runInit`:

```typescript
if (existsSync(join(opts.projectDir, ".gyst")) && !opts.force) {
  process.stdout.write(
    "Gyst is already initialized. Run with --force to rebuild, or `gyst dashboard` to explore.\n"
  );
  return;
}
```

If `.gyst/` exists and `--force` is not set: print message, exit 0.
If `--force`: print "Rebuilding your context layer..." and proceed.

---

## 4. Environment Detection

`detectEnvironment(projectDir: string): DetectResult` — synchronous, no spawning.

```typescript
interface DetectResult {
  projectTypes: string[];          // ["TypeScript", "Node.js"] etc.
  hasGit: boolean;
  commitCount: number;             // 0 if no git
  detectedAgents: AgentInfo[];     // { name, marker }
  hasLlmKey: boolean;
}
```

**Project type detection** — `existsSync` checks in `projectDir`:
- `tsconfig.json` → "TypeScript"
- `package.json` → "Node.js" (only if tsconfig not found)
- `Cargo.toml` → "Rust"
- `pyproject.toml` or `requirements.txt` → "Python"
- `go.mod` → "Go"
- `Gemfile` → "Ruby"

Reports first match only (or "Unknown project").

**Git detection** — calls `simpleGit(projectDir).log({ maxCount: 1 })`, reads total from `total.all`. If `checkIsRepo()` throws: `hasGit = false`, `commitCount = 0`. Uses try/catch — never throws.

**Agent detection** — `existsSync` checks (Claude Code uses `.mcp.json` as marker):
- `.mcp.json` → "Claude Code"
- `.cursor/` → "Cursor"
- `~/.gemini/` → "Gemini CLI"
- `~/.codeium/windsurf/` → "Windsurf"
- `~/.codex/` → "Codex CLI"

**LLM key**: `!!process.env.ANTHROPIC_API_KEY`

Detection runs before any DB work — results feed both the display and the orchestration decisions.

---

## 5. Progress Renderer (ProgressUI)

Sequential line output — no cursor movement, no overwrite. Works in TTY and CI logs.

```typescript
class ProgressUI {
  box(title: string): void          // opens a box with ╭─ title ─╮
  step(label: string, count: number, warn?: boolean): void  // prints one completed line
  detectionLine(label: string, detail?: string, ok?: boolean): void
  closeBox(): void                  // closes with ╰───────────╯
  summary(stats: KBStats, elapsed: number): void
}
```

Each line is printed once after the phase completes — no cursor movement, no overwrite. Works identically in TTY and CI logs.

ANSI color scheme:
- Done (count > 0): `green ◇` — `◇ label ... N entries`
- Done (count = 0, no error): `dim ◇` — `◇ label ... 0 entries`
- Warning (phase threw): `yellow ⚠` — `⚠ label (failed)`
- Detection success: `green ✓`
- Detection miss: `dim ✗`

Box width: fixed at 51 chars interior. Counts right-align within the box.

Output sequence:
```
Welcome to Gyst. Let's make your AI agent smarter.

╭─ Detecting environment ─────────────────────────╮
│  ✓ TypeScript project (tsconfig.json)           │
│  ✓ Git repository (342 commits)                 │
│  ✓ Claude Code detected                         │
│  ✓ Cursor detected                              │
╰─────────────────────────────────────────────────╯

╭─ Building your context layer ───────────────────╮
│  ✓ Scanning source files ............ 47 files  │
│  ✓ Reading documentation ............ 12 docs   │
│  ✓ Knowledge graph .................. 89 edges  │
│  ✓ Git history ...................... 23 entries │
│  ✓ Code comments .................... 8 entries │
│  ✓ Hot files ........................ 3 entries │
│  ✓ Test patterns .................... 5 entries │
│  ✓ Ghost knowledge .................. 10 entries│
╰─────────────────────────────────────────────────╯

╭─ Configuring agents ────────────────────────────╮
│  ✓ Claude Code: MCP + hooks installed           │
│  ✓ Cursor: MCP installed                        │
╰─────────────────────────────────────────────────╯

✨ Done in 67s.
Your AI agent now knows:
• 14 conventions  • 8 decisions  • 12 error patterns  • 23 learnings
Next: gyst dashboard  |  Open a new agent session — it'll feel different.
```

---

## 6. Orchestration Sequence

Each phase is wrapped in `try/catch`. A failed phase logs a warning line (`⚠`) but never aborts the run. Final summary always appears.

```
1. loadConfig(projectDir)
2. initDatabase(config.dbPath)                              — sync
3. runSelfDocumentPhase1(db, projectDir)                    → "Scanning source files"
4. runSelfDocumentPhase2(db, projectDir)                    → "Reading documentation"
5. runSelfDocumentPhase3Link(db)                            → "Knowledge graph"  (sync)
6. mineGitPhase(db, { repoRoot: projectDir, noLlm, full: false })  → "Git history"  (skip if noGit)
7. mineCommentsPhase(db, { repoRoot: projectDir, noLlm, full: false }) → "Code comments"
8. mineHotPathsPhase(db, { repoRoot: projectDir, noLlm, full: false }) → "Hot files"
9. mineTestsPhase(db, { repoRoot: projectDir, noLlm, full: false })    → "Test patterns"
10. runSelfDocumentPhase4NoLLM(db, 10)                      → "Ghost knowledge"
11. installForDetectedTools(projectDir)                     → "Configuring agents" box
12. installHooksForDetectedTools(homedir(), scriptsDir)     → adds hooks line per agent
13. db.close()
14. ui.summary(stats, elapsed)
```

**`noLlm` auto-set**: if `opts.noLlm` is false but `!hasLlmKey`, set `noLlm = true` before phases start.

**`noGit` auto-set**: if `opts.noGit` is false but `!hasGit`, set `noGit = true`.

**`scriptsDir`**: resolved via `import.meta.url` → `dirname(thisFile)/../../plugin/scripts` (same pattern as the `setup` command added in installer wiring task).

---

## 7. KB Stats for Summary

After all phases complete, query the DB for a quick count:
```typescript
const stats = {
  conventions: db.query<{n:number}>("SELECT count(*) n FROM entries WHERE type='convention'").get()?.n ?? 0,
  decisions:   db.query<{n:number}>("SELECT count(*) n FROM entries WHERE type='decision'").get()?.n ?? 0,
  errors:      db.query<{n:number}>("SELECT count(*) n FROM entries WHERE type='error_pattern'").get()?.n ?? 0,
  learnings:   db.query<{n:number}>("SELECT count(*) n FROM entries WHERE type='learning'").get()?.n ?? 0,
}
```

---

## 8. CLI Wiring in `src/cli/index.ts`

### `init` command

```typescript
program
  .command("init")
  .description("Bootstrap your AI agent context layer (90-second setup)")
  .option("--no-llm", "Skip LLM calls (auto-set if ANTHROPIC_API_KEY is absent)")
  .option("--no-git", "Skip git mining (for non-git projects)")
  .option("--yes", "Skip confirmation prompts (for CI)")
  .option("--force", "Re-run even if already initialized")
  .action(async (options) => {
    const { runInit } = await import("./commands/init.js");
    // Commander.js: --no-llm sets options.llm = false; --no-git sets options.git = false
    await runInit({
      noLlm: options.llm === false,
      noGit: options.git === false,
      force: options.force ?? false,
      projectDir: process.cwd(),
    });
  });
```

### Default no-args action

Add to `program` (Commander root):
```typescript
program.action(() => {
  process.stdout.write(
    "\nGyst — context layer for AI coding agents\n" +
    "  Quick start: gyst init\n" +
    "  Explore:     gyst dashboard\n" +
    "  Run 'gyst --help' for all commands.\n\n"
  );
});
```

This fires when `gyst` is run with no subcommand and no flags.

---

## 9. Error Handling

- Each phase wrapped in `try/catch` — failure sets count to 0, renders `⚠` line
- Phase failures accumulate; all are reported in console after the run only if any failed:
  ```
  ⚠ 2 phases had warnings. Run `gyst status` for details.
  ```
- `db.close()` called in `finally` block — DB always cleaned up
- If `initDatabase` itself throws: print error and exit 1 (hard failure, nothing can proceed)

---

## 10. Testing

- `tests/cli/init.test.ts` — unit tests for `detectEnvironment` using tmpdir fixtures
- Integration test: `runInit` called on a tmpdir with a minimal git repo + tsconfig.json — assert DB has entries and config files written

---

## 11. Out of Scope

- Context file generation (`.cursorrules`, `AGENTS.md`, Gemini system prompt) — Prompt 4
- Team setup during init
- `--update` mode (future)
- Cline detection (not in current installer)
