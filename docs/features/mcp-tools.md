# MCP Tools Reference

Gyst exposes 14 tools over the Model Context Protocol. All tools use the stdio transport by default; an HTTP transport is available for team mode. Tools are registered in `src/mcp/server.ts` via individual `register*Tool()` functions.

All inputs are validated with Zod before processing. All outputs are plain text formatted for AI consumption.

---

## `learn`

**Purpose**: Record a knowledge entry into the team knowledge base.

Use this after solving a bug, making an architectural decision, discovering a convention, or reaching a conclusion worth remembering. The tool deduplicates against existing entries by error signature fingerprint before inserting.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | yes | `error_pattern`, `convention`, `decision`, `learning`, `ghost_knowledge` |
| `title` | string (5–200) | yes | Short, searchable title |
| `content` | string (10–5000) | yes | Full description of what was learned |
| `files` | string[] | no | Source file paths this entry relates to |
| `error_type` | string | no | Error class name (for `error_pattern`) |
| `error_message` | string | no | Raw error text, will be normalized |
| `tags` | string[] | no | Free-form tags |
| `scope` | `personal` \| `team` \| `project` | no | Defaults to mode-based value |

**What it does**:
1. Validates input with Zod
2. Strips sensitive data from `content` and `error_message`
3. Normalizes the error message into a canonical signature (if `error_pattern`)
4. Checks for duplicates by `error_signature`; merges if found (increments `source_count`)
5. Extracts code entities from title and content, attaches them as `entity:Name` tags
6. Persists to SQLite (entries, entry_files, entry_tags, sources tables) in a transaction
7. Optionally writes a markdown file (if `autoExport` is enabled)
8. If `globalDb` is configured, writes a personal copy there
9. Fires embedding storage asynchronously (if system SQLite supports extensions)
10. Auto-links to existing entries sharing entity tags (up to 20 links)
11. Logs activity in team mode

**Returns**: `"Learned: \"<title>\" (<type>, id: <uuid>)"` or `"Updated existing entry (merged): ..."` on dedup.

---

## `recall`

**Purpose**: Full-content search of the knowledge base, formatted for immediate agent use.

Use before writing code to surface applicable rules, decisions, and error patterns. Returns formatted content within a configurable token budget.

**Key parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string (2–500) | — | Natural language search query |
| `type` | enum | `all` | Filter to a specific entry type |
| `files` | string[] | `[]` | Boost entries associated with these files |
| `max_results` | 1–10 | `5` | Maximum entries to return |
| `scope` | enum | — | Optional scope filter |
| `developer_id` | string | — | Show personal entries belonging to this developer |
| `context_budget` | 200–20000 | config default | Token budget for response |

**What it does**:
1. Runs 5 search strategies in parallel (see `docs/features/search.md`)
2. Classifies query intent (temporal, debugging, code_quality, conceptual)
3. Fuses results with Reciprocal Rank Fusion (k=60)
4. Over-fetches (3× `max_results`) then hydrates entries from DB
5. Applies scope-based visibility filtering
6. Applies post-hydration boosts: ghost_knowledge +0.15, convention +0.05, consolidated +0.10
7. Applies intent-based boosts (e.g., `debugging` boosts `error_pattern`)
8. Sorts by tier (ghost=0, convention=1, everything else=2) then by boosted score
9. Filters entries below `config.confidenceThreshold` (ghost_knowledge always included)
10. Falls back to `globalDb` if local results are empty
11. Records co-retrieval for pairs of results
12. Appends structural sidecar context when budget allows (≥1500 tokens)
13. Formats to one of four tiers based on `context_budget`

**Formatting tiers**:
| Budget | Tier | Content |
|--------|------|---------|
| ≥5000 | full | Up to 5 entries with title, body, files, tags |
| 2000–4999 | compact | Top 3, first 2 sentences |
| 800–1999 | minimal | Top 2, 80-char summary |
| <800 | ultra-minimal | Top 1, first sentence only |

**Returns**: Formatted markdown text. Ghost entries prefixed `⚠️ Team Rule:`. Convention entries prefixed `📏 Convention:`.

---

## `search`

**Purpose**: Compact knowledge index — same pipeline as `recall` but returns only metadata.

Use when browsing multiple entries before deciding which to read in full. Roughly 7× more token-efficient than `recall` for discovery.

**Key parameters**: Same as `recall` except `context_budget` is replaced by `limit` (1–50, default 10).

**Returns**: One block per result:
```
<uuid> · <type> · <confidence%> · <age>
<title>
ref: gyst://entry/<uuid>
```

Follow up with `get_entry` for full content on entries of interest.

---

## `get_entry`

**Purpose**: Fetch the full content of a single entry by ID.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Entry UUID or hash-based ID |

**Returns**: Full formatted entry content including title, body, files, tags, confidence, scope, and a `gyst://entry/<id>` citation URI.

---

## `conventions`

**Purpose**: List coding standards relevant to a specific directory or tag set.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | string | no | Filter to conventions associated with this path |
| `tags` | string[] | no | Filter by tags |

**Returns**: All active `convention` entries matching the filters, formatted as a list. Returns team-wide conventions if no directory is specified.

---

## `check_conventions`

**Purpose**: Check whether a specific file violates any stored conventions.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | Path of the file to check |
| `content` | string | yes | The file's current content |

**What it does**: Loads all `convention` entries, runs each convention's rules against the provided content, and returns a list of violations with line-level guidance.

**Returns**: List of violations, or confirmation that the file passes all known conventions.

---

## `failures`

**Purpose**: Match a new error against known error patterns.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error_message` | string | yes | The error text to match |
| `error_type` | string | no | Exception class or error code |
| `files` | string[] | no | Files involved (boosts file-path matches) |

**What it does**:
1. Normalizes the incoming error message using the same pipeline as `learn`
2. Checks for an exact `error_signature` match in the DB
3. Falls back to BM25 search on the normalized text
4. Returns matching entries with their fix descriptions

**Returns**: Matching error pattern entries or `"No matching patterns found"`.

---

## `check`

**Purpose**: Run all violation detectors against a file in one call.

Combines `check_conventions` and `failures` for a comprehensive pre-commit or pre-review check.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | File to check |
| `content` | string | yes | Current file content |

**Returns**: Aggregated list of convention violations and known error patterns relevant to this file.

---

## `graph`

**Purpose**: Query the relationship graph between knowledge entries.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | `neighbors` \| `path` \| `similar` \| `clusters` \| `hubs` | yes | Query type |
| `entry_id` | string | for `neighbors`, `path`, `similar` | Starting node |
| `target_id` | string | for `path` | Destination node |
| `limit` | number | no | Max results |

**What it does by mode**:
- `neighbors` — returns the one-hop subgraph around `entry_id`
- `path` — BFS shortest path between `entry_id` and `target_id` (max 6 hops)
- `similar` — entries sharing tags or files with `entry_id`
- `clusters` — connected components of 2+ nodes, sorted by size (top 20)
- `hubs` — most-connected entries by degree (relationships + co-retrieval count)

**Returns**: Node/edge list formatted as markdown or JSON depending on mode.

---

## `feedback`

**Purpose**: Rate a knowledge entry helpful or unhelpful after using it.

Drives the confidence calibration loop. Over time, entries that are consistently unhelpful decay faster; consistently helpful entries gain confidence.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entry_id` | string | yes | The entry being rated |
| `helpful` | boolean | yes | `true` = helpful, `false` = unhelpful |
| `note` | string (≤500) | no | Optional freeform note |
| `developer_id` | string | no | Who is providing feedback |

**What it does**: Adjusts `entries.confidence` by `+0.02` for helpful or `-0.05` for unhelpful. Stores the feedback event in the `feedback` table for calibration analysis.

**Returns**: Confirmation with the new confidence value.

---

## `harvest`

**Purpose**: Extract knowledge entries automatically from a raw session transcript.

This is the zero-effort adoption path: the agent calls `harvest` at session end with the full conversation transcript, and Gyst extracts structured entries without requiring explicit `learn` calls.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `transcript` | string (1–100,000) | yes | Full session transcript text |
| `session_id` | string | no | Deduplication key — re-harvesting same session is a no-op |
| `developer_id` | string | no | Attribute extracted entries to this developer |

**Processing pipeline**:
1. Noise filter: drop pure code output, system prompts, tool blocks
2. Pattern extraction: regex-based scanning for errors fixed, decisions made, conventions discovered, learnings
3. Error pairing: error descriptions linked with nearby fix descriptions
4. Each extracted item is passed through the full `learn` pipeline (normalize → dedupe → store)
5. Session tracked in `sources` table keyed by `session_id` so re-harvest is idempotent

**Returns**: Summary: `"Harvested N entries: X created, Y merged, Z skipped"`

---

## `activity`

**Purpose**: Query recent team activity — who did what and when.

Only available in team mode (requires `activity_log` table).

**Key parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | 1–168 | `24` | Lookback window in hours |
| `developer_id` | string | — | Filter to a specific developer |
| `action` | string | — | Filter to a specific action type |

**Returns**: List of activity events with developer, action, timestamp, and affected files. Returns guidance message if team features are not configured.

---

## `status`

**Purpose**: Health check and team awareness snapshot.

**Key parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | 1–48 | `2` | Lookback window for active developers |

**What it returns**:
- Total active entries, broken down by type
- Developers active in the last N hours with their recent actions and files touched
- Count of conflicted entries needing resolution
- If team features are not configured, a setup guidance message

The response is capped at 2,000 tokens.

---

## `configure`

**Purpose**: Read or write project configuration at runtime without editing `.gyst-wiki.json` manually.

**Key parameters** (all optional — omit to read current config):

| Parameter | Type | Description |
|-----------|------|-------------|
| `teamMode` | boolean | Enable/disable team mode |
| `autoExport` | boolean | Auto-write markdown files on learn |
| `maxRecallTokens` | integer (≤32,000) | Default token budget for recall responses |
| `confidenceThreshold` | number (0–1) | Minimum confidence for recall results |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` | Log verbosity |

Fields that require a server restart (`dbPath`, `wikiDir`, `globalDbPath`) are intentionally not exposed by this tool.

**What it does**: Reads `.gyst-wiki.json`, merges the provided fields (preserving untouched keys), and writes the file back. If called with no parameters, returns the current configuration as JSON.

**Returns**: Confirmation of changes applied, or current config if read-only call.
