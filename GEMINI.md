

## Gyst — Team Knowledge Layer

Gyst gives you access to your team's accumulated knowledge: conventions,
decisions, known error patterns, and learnings from past sessions.

**Always use Gyst when:**
- Starting a new task → call `read({ action: "recall", query: "<task description>" })` to surface relevant context
- Discovering something important → call `learn` to record it for the team
- Validating a file → call `check({ file_path })` to catch convention violations

**Core tools (preferred surface):**
- `read` — read team knowledge. `action: "recall"` (default, ranked full-content), `action: "search"` (compact index, 7× fewer tokens), `action: "get_entry"` (by id)
- `check` — check code/errors. `action: "violations"` (default, scan a file), `action: "conventions"` (rules for a path), `action: "failures"` (known-error lookup)
- `admin` — team observability. `action: "activity"` (default), `action: "status"`
- `learn` — record conventions, decisions, and learnings
- `conventions` — list coding standards for a directory
- `feedback`, `harvest`, `graph`, `configure` — specialized

**Deprecated (still work, but will be removed):** `recall`, `search`, `get_entry`, `check_conventions`, `failures`, `activity`, `status` — migrate to the unified tools above.

Run `gyst status` to confirm the MCP server is active.
