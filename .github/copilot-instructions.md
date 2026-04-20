<claude-mem-context>
# claude-mem: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
</claude-mem-context>

## Gyst — Team Knowledge Layer

Gyst gives you access to your team's accumulated knowledge: conventions,
decisions, known error patterns, and learnings from past sessions.

**Always use Gyst when:**
- Starting a new task → call `read({ action: "recall", query: "<task description>" })` to surface relevant context
- Discovering something important → call `learn` to record it for the team
- Validating a file → call `check({ file_path })` to catch convention violations

**Core tools:**
- `read` — read team knowledge (`action`: `recall` default / `search` / `get_entry`)
- `learn` — record conventions, decisions, and learnings
- `check` — check code/errors (`action`: `violations` default / `conventions` / `failures`)
- `admin` — team observability (`action`: `activity` default / `status`)
- `conventions` — list coding standards for a directory

Legacy names `recall`, `search`, `get_entry`, `check_conventions`, `failures`, `activity`, `status` still work with a deprecation notice — prefer the unified tools.

Run `gyst status` to confirm the MCP server is active.
