# Team vs. Personal Knowledge

## Overview

Every knowledge entry belongs to one of three scopes: `personal`, `team`, or `project`. Scope determines who can see an entry. The MCP server runs in one of two modes — `personal` or `team` — and the mode affects both the default scope for new entries and how recall filters search results.

---

## The Three Scopes

### `team`

Entries visible to every developer using this knowledge base. These are the shared facts the whole team benefits from: conventions, architectural decisions, known error patterns, ghost knowledge.

When an agent calls `learn` in team mode without specifying `scope`, entries default to `team`.

### `personal`

Entries visible only to the developer who created them. Identified by the `developer_id` column on the `entries` table. Personal entries are filtered out of recall results unless the caller provides a matching `developer_id` parameter.

Ghost knowledge entries are always `team`, never personal — they represent hard constraints for the whole team. This is enforced in the `learn` tool:

```typescript
const defaultScope = valid.type === "ghost_knowledge"
  ? "team"
  : ctx.mode === "team"
    ? "team"
    : "personal";
const resolvedScope = valid.scope ?? defaultScope;
```

### `project`

Treated identically to `team` in all queries — visible to everyone. Semantically used for entries that are specific to this repository rather than general team knowledge. In practice, most entries use `team`; `project` is available for fine-grained documentation workflows.

---

## Server Mode: `personal` vs. `team`

The MCP server starts in one of two modes, configured in `.gyst-wiki.json` (`teamMode: true/false`).

### Personal Mode (default)

- Default scope for new entries: `personal`
- When no `developer_id` is provided to `recall`, all entries are visible (the database belongs to a single user)
- No `developer_id` filtering is applied because there is no multi-user context
- The `globalDb` fallback is available: if local recall yields no results, the server checks `~/.gyst/global.db`

This mode is designed for solo developers or anyone using Gyst before joining a team.

### Team Mode

- Default scope for new entries: `team`
- The server carries a `ctx.developerId` and `ctx.teamId` from the HTTP auth layer
- Personal entries are only returned when `recall` is called with a matching `developer_id`
- Activity is logged to `activity_log` on every `learn`, `recall`, and `search` call
- Ghost knowledge is always `team`

---

## How Recall Filters by Scope

The `fetchEntries` function in `src/mcp/tools/recall.ts` applies scope filtering after search results are ranked:

```typescript
// With a known developer_id — team + project entries, plus caller's personal entries
SELECT ... WHERE scope IN ('team', 'project')
   OR (scope = 'personal' AND developer_id = ?)

// In personal mode with no developer_id — show everything (single-user DB)
SELECT ... WHERE status IN ('active', 'consolidated')
  -- no scope clause at all

// Team mode, no developer_id provided — team and project only
SELECT ... WHERE scope IN ('team', 'project')
```

The same logic applies in `searchByBM25` — the scope clause is injected into the FTS5 query so personal entries never leak into results for other developers.

---

## The `learn` Tool: Scope Parameter

The `scope` parameter on `learn` is optional. When omitted, the server applies mode-based defaults. When provided, it overrides the default entirely.

```json
{
  "type": "learning",
  "title": "Local dev setup requires Homebrew SQLite",
  "content": "On macOS, you must point GYST_SQLITE_PATH at the Homebrew SQLite...",
  "scope": "personal"
}
```

Valid values: `"personal"`, `"team"`, `"project"`.

Use `"personal"` for:
- Local environment setup notes
- Personal preferences and shortcuts
- Entries that are not relevant to other team members

Use `"team"` for:
- Bug fixes with root causes
- Architectural decisions
- Conventions the whole codebase follows
- Known error patterns

---

## Global Personal Memory

When `ctx.globalDb` is set (configured via `globalDbPath` in `.gyst-wiki.json`), the `learn` tool writes a second copy of every personal entry to the global database at `~/.gyst/global.db`. The copy is always stored with `scope = 'personal'`.

On recall, if the local database returns zero results and `ctx.globalDb` exists, the recall tool runs BM25 and semantic search against the global DB as a fallback. Results from the global DB are prefixed with `🌎 Global Memory:` in the formatted output.

This lets a developer accumulate personal knowledge across projects — lessons learned in one repo surface when working in another.

---

## Developer Identity

`developer_id` is a plain string — typically a git email, GitHub username, or any stable identifier. It is passed in by the client (the AI tool's MCP configuration) or derived from the HTTP auth layer in team mode.

In team mode, `ctx.developerId` is set for the lifetime of the server connection. The `developer_id` parameter on individual `learn` and `recall` calls can override it for specific entries.

There is no authentication within the MCP protocol layer itself. Trust is delegated to the transport: in team mode, the HTTP server validates tokens before setting `ctx.developerId`. In personal/stdio mode, all access is trusted.

---

## Joining a Team

When a developer runs `gyst join <team-url>` or configures team mode:

1. `.gyst-wiki.json` is updated with `teamMode: true` and the team server URL
2. The MCP configuration for all registered AI tools is updated to point at the team HTTP endpoint
3. Subsequent `learn` calls default to `scope: "team"` and are replicated to the shared database
4. Recall sees the full team knowledge base in addition to the developer's own personal entries
5. Activity logging begins, feeding the `status` tool's team awareness view

Pre-existing personal entries remain personal — joining a team does not retroactively promote personal entries to team scope.
