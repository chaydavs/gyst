# Team Mode

## Overview

Team mode enables a shared knowledge base where multiple developers contribute to and read from the same pool of entries. In personal mode (the default), the SQLite database is local to one developer's machine. In team mode, entries are shared via a central server, activity is logged, and `developer_id` is used to attribute contributions and filter personal entries.

---

## Architecture

In personal mode:
- The MCP server runs over stdio transport
- The database is at `~/.gyst/<project-slug>/gyst.db` or `gyst-wiki/gyst.db`
- All entries are visible to whoever runs the server
- No authentication is required

In team mode:
- A central HTTP server hosts the knowledge base
- Each developer's AI tools connect to the central server's MCP endpoint over HTTP
- The HTTP server validates tokens and injects `developer_id`, `team_id` into every request context
- Activity is logged to `activity_log` on every write and read operation
- `scope = 'team'` is the default for new entries

---

## ToolContext in Team Mode

Every MCP tool receives a `ToolContext` that differs between modes:

```typescript
interface ToolContext {
  db: Database;
  mode: "personal" | "team";
  developerId?: string;       // set in team mode from HTTP auth
  teamId?: string;            // set in team mode from HTTP auth
  globalDb?: Database;        // set in personal mode when globalDbPath configured
}
```

When `ctx.mode === "team"` and `ctx.developerId` is set:
- New entries default to `scope = 'team'`
- Activity is logged after every learn, recall, search, and feedback call
- The `status` tool returns active teammates and their recent actions
- Personal entries are only visible when `developer_id` matches

---

## Creating a Team

The `gyst team init` command creates a new team configuration:

1. Generates a `teamId` (UUID)
2. Writes `teamMode: true` to `.gyst-wiki.json`
3. Creates the `activity_log` table in the database
4. Generates an invite URL and initial developer token

After initialization, the project's MCP configuration is updated to point at the team HTTP server.

---

## Activity Logging

**Function**: `logActivity(db, teamId, developerId, action, entryId?, files?)`

Called after every significant operation in team mode. Writes to the `activity_log` table:

```sql
INSERT INTO activity_log (team_id, developer_id, action, entry_id, files, created_at)
VALUES (?, ?, ?, ?, ?, datetime('now'))
```

Action types: `learn`, `recall`, `search`, `feedback`, `configure`

The `status` MCP tool queries this table:

```sql
SELECT developer_id,
       COUNT(*) AS action_count,
       MAX(created_at) AS last_seen,
       GROUP_CONCAT(DISTINCT action) AS actions
FROM activity_log
WHERE team_id = ?
  AND created_at >= datetime('now', '-? hours')
GROUP BY developer_id
ORDER BY last_seen DESC
```

This lets any team member (or their AI agent) ask "who is actively working and what are they doing?"

---

## Invite Flow

To add a new developer to the team:

1. An existing member runs `gyst team invite <developer-id>` or uses the dashboard "Invite" flow
2. A time-limited invite token is generated and shared (invite link or QR code)
3. The new developer runs `gyst join <invite-url>` on their machine

When `gyst join` runs:
1. Validates the invite token against the team server
2. Writes team server URL and developer token to `~/.gyst/auth.json`
3. Updates `.gyst-wiki.json` with `teamMode: true` and the server URL
4. Updates the MCP configuration for all registered AI tools (Claude Code, Cursor, Codex CLI, etc.)
5. Bootstraps the local database from the team server (initial sync)

After joining, `developer_id` is derived from the token on every HTTP request to the team server.

---

## MCP Configuration Update

When installing or joining a team, `src/mcp/installer.ts` auto-detects which AI tools are installed and updates their MCP configuration:

- **Claude Code**: writes to `~/.claude/settings.json` under `mcpServers`
- **Cursor**: writes to `.cursor/mcp.json` in the project
- **Codex CLI**: writes to `.codex/mcp.json`
- **Gemini CLI**: writes to `.gemini/mcp.json`
- **Windsurf**: writes to `.windsurf/mcp.json`
- **Cline**: writes to `.cline/mcp.json`

In personal mode, the MCP server command is the stdio binary:
```json
{
  "command": "gyst",
  "args": ["mcp"]
}
```

In team mode, the configuration points at the HTTP endpoint:
```json
{
  "url": "https://team.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

This update happens automatically on `gyst install`, `gyst join`, and `gyst setup`. Developers do not need to manually edit AI tool configuration.

---

## HTTP Server

The team HTTP server is started with `gyst server` (or as a daemon via `gyst server --daemon`). It listens on port 3579 by default (same port as the dashboard).

The server routes:
- `/mcp` — MCP endpoint (streamable HTTP transport)
- `/api/*` — Dashboard REST API
- `/` — React dashboard UI

Authentication middleware (`src/server/auth.ts`) validates the Bearer token on every MCP request, looks up the associated `developer_id` and `team_id`, and injects them into `ctx` before the tool handler runs.

---

## Dashboard Team Panel

The Team Management section of the dashboard shows:
- Member roster with expandable cards
- Per-member stats: learns this week, recall rate, last active
- Invite flow for adding new developers
- Danger zone: remove member, rotate tokens, delete team

The panel fetches from `/api/team/members` and `/api/activity?hours=168`.
