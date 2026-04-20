# MCP Tools Reference

Gyst exposes **3 primary tools** over the Model Context Protocol, plus **5 extended tools** that can be enabled when needed. All tools use the stdio transport by default; an HTTP transport is available for team mode. Tools are registered in `src/mcp/register-tools.ts`.

All inputs are validated with Zod before processing. All outputs are plain text formatted for AI consumption.

---

## Primary Tools (always available)

These three tools cover all everyday agent workflows. Extended tools add power-user capabilities for graph queries, feedback loops, and configuration.

---

### `learn`

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
8. Fires embedding storage asynchronously (if system SQLite supports extensions)
9. Auto-links to existing entries sharing entity tags (up to 20 links)
10. Logs activity in team mode

**Returns**: `"Learned: \"<title>\" (<type>, id: <uuid>)"` or `"Updated existing entry (merged): ..."` on dedup.

---

### `recall`

**Purpose**: Multi-mode access to the knowledge base.

Use `recall` for all knowledge retrieval. The `mode` parameter selects the behavior; `search` (full ranked retrieval) is the default.

**Key parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | enum | `search` | Operating mode (see below) |
| `query` | string (1–500) | — | Natural language search query or entry id (for `single`) |
| `type` | enum | `all` | Filter to a specific entry type |
| `files` | string[] | `[]` | Boost entries associated with these files |
| `max_results` | 1–10 | `5` | Maximum entries to return |
| `scope` | enum | — | Optional scope filter |
| `developer_id` | string | — | Show personal entries belonging to this developer |
| `context_budget` | 200–20000 | config default | Token budget for response |
| `id` | string | — | For `mode=single`: the entry id to fetch |
| `directory` | string | — | For `mode=conventions`: directory prefix filter |
| `tags` | string[] | — | For `mode=conventions`: tag filter |
| `error_message` | string | — | For `mode=failures`: the error text to match |
| `error_type` | string | — | For `mode=failures`: optional error type |

**Modes**:

| Mode | What it does | Migration note |
|------|-------------|----------------|
| `search` (default) | Full ranked recall with RRF fusion. Runs 5 search strategies in parallel, fuses with RRF (k=60), applies intent boosts, returns formatted results within token budget. | Was the standalone `recall` tool |
| `index` | Compact token-efficient index. Returns `id · type · confidence · title` for each result — roughly 7x more efficient than `search` for discovery. Follow with `mode=single` for full content. | Was the standalone `search` tool |
| `single` | Fetch full content for one entry by id. Pass the id in either `query` or `id`. | Was the standalone `get_entry` tool |
| `conventions` | List team coding standards. Filters by `directory` and/or `tags`. Returns all active `convention` entries matching the filters. | Was the standalone `conventions` tool |
| `failures` | Match an error against known error patterns. Normalizes the incoming error, checks for exact signature match, falls back to BM25. | Was the standalone `failures` tool |

**Formatting tiers** (for `mode=search`):
| Budget | Tier | Content |
|--------|------|---------|
| ≥5000 | full | Up to 5 entries with title, body, files, tags |
| 2000–4999 | compact | Top 3, first 2 sentences |
| 800–1999 | minimal | Top 2, 80-char summary |
| <800 | ultra-minimal | Top 1, first sentence only |

**Returns**: Formatted markdown text. Ghost entries prefixed with a warning indicator. Convention entries prefixed with a ruler indicator.

---

### `check`

**Purpose**: Run all violation detectors against a file in one call.

Combines convention checking and error pattern matching for a comprehensive pre-commit or pre-review check.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | yes | File to check |
| `content` | string | yes | Current file content |

**What it does**: Loads all `convention` entries, runs each convention's rules against the provided content, and returns a list of violations with line-level guidance. Also checks the content against known error patterns.

**Returns**: Aggregated list of convention violations and known error patterns relevant to this file, or confirmation that the file passes.

---

## Extended Tools (enabled by `exposeExtendedTools: true`)

Enable in `.gyst-wiki.json`:
```json
{ "exposeExtendedTools": true }
```
Or via CLI: `gyst configure --extended-tools`.

When disabled (the default), these tools are not registered at all — they do not appear in the agent's tool list and cannot be accidentally called.

---

### `graph`

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

### `feedback`

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

### `harvest`

**Purpose**: Extract knowledge entries automatically from a raw session transcript.

This is the zero-effort adoption path: the agent calls `harvest` at session end with the full conversation transcript, and Gyst extracts structured entries without requiring explicit `learn` calls.

**Key parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `transcript` | string (1–100,000) | yes | Full session transcript text |
| `session_id` | string | no | Deduplication key — re-harvesting same session is a no-op |
| `developer_id` | string | no | Attribute extracted entries to this developer |

**Returns**: Summary: `"Harvested N entries: X created, Y merged, Z skipped"`

---

### `status`

**Purpose**: Health check, team awareness snapshot, and recent activity.

Absorbs the former `activity` tool — use the `hours` parameter to look back at recent team events.

**Key parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | 1–168 | `2` | Lookback window for active developers and activity |
| `developer_id` | string | — | Filter activity to a specific developer |
| `action` | string | — | Filter activity to a specific action type |

**What it returns**:
- Total active entries, broken down by type
- Developers active in the last N hours with their recent actions and files touched
- Count of conflicted entries needing resolution
- Recent activity events with developer, action, timestamp, and affected files
- If team features are not configured, a setup guidance message

The response is capped at 2,000 tokens.

---

### `configure`

**Purpose**: Read or write project configuration at runtime without editing `.gyst-wiki.json` manually.

**Key parameters** (all optional — omit to read current config):

| Parameter | Type | Description |
|-----------|------|-------------|
| `teamMode` | boolean | Enable/disable team mode |
| `autoExport` | boolean | Auto-write markdown files on learn |
| `maxRecallTokens` | integer (≤32,000) | Default token budget for recall responses |
| `confidenceThreshold` | number (0–1) | Minimum confidence for recall results |
| `exposeExtendedTools` | boolean | Enable/disable extended tool registration |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` | Log verbosity |

Fields that require a server restart (`dbPath`, `wikiDir`, `globalDbPath`) are intentionally not exposed by this tool.

**What it does**: Reads `.gyst-wiki.json`, merges the provided fields (preserving untouched keys), and writes the file back. If called with no parameters, returns the current configuration as JSON.

**Returns**: Confirmation of changes applied, or current config if read-only call.
