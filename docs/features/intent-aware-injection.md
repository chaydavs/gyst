# Intent-Aware Context Injection

## Overview

Gyst injects relevant team knowledge into the agent's context at two points in every session — before the agent has even called `recall()`. This zero-effort delivery model means agents get the right context automatically, without being trained to call specific tools first.

---

## Two-Layer Injection Model

### Layer 1 — SessionStart: Standing Team Knowledge

**Hook:** `plugin/scripts/session-start.js` (fires once per session, 5s timeout)

**What is injected:** Ghost knowledge entries, top conventions for the current directory, recent team activity, and a drift warning if the knowledge base health score exceeds 0.4.

**How it works:** The hook runs `gyst inject-context --always-on --graph-traverse` **synchronously** and returns the output as `additionalContext` in the hook response. Claude Code prepends this block to the agent's system context before the first user message is processed.

**When it fires:** Every session, unconditionally.

**Contents are tuned for breadth:** ghost knowledge (hard constraints), conventions (standing rules), and activity (who is doing what right now). These are stable facts that apply regardless of what the user asks.

---

### Layer 2 — UserPromptSubmit: Task-Specific Recall

**Hook:** `plugin/scripts/prompt.js` (fires on every prompt, 2000ms timeout)

**What is injected:** Results of a `recall` search against the user's first prompt — the 3 most relevant entries from the full knowledge base, formatted as a context block.

**When it fires:** Only on the **first prompt of a session**. Subsequent prompts are observational.

**Contents are tuned for depth:** because the injection is keyed to the actual prompt text, the results are directly relevant to what the user is about to ask.

---

## First-Prompt Detection: Flag File Mechanism

Detecting "is this the first prompt?" reliably requires state that persists across multiple invocations of the hook script (which is a short-lived Node.js process, not a daemon).

**Flag file path:**
```
{tmpdir()}/.gyst-sessions/{sessionId}-injected
```

**Lifecycle:**

1. Hook fires. `sessionId` is read from the normalized stdin payload.
2. The `.gyst-sessions/` directory is created if it does not exist.
3. Opportunistic 24h cleanup: any flag files older than 24 hours are deleted.
4. Check if the flag file exists. If it does not exist, this is the first prompt.
5. **Write the flag file immediately** — before attempting recall. This prevents infinite retry if the script crashes or the recall command fails.
6. Proceed with recall + injection (first prompt) or skip to emit-only path (subsequent prompts).

The flag is written in both the success and failure paths. A recall timeout or a failed `gyst` process does not leave the session in a state where injection is retried on the next prompt.

---

## JSON Format for Recall Output

The first-prompt injection uses `gyst recall ... --format json` to get machine-readable output:

```json
{
  "intent": "debugging",
  "results": [
    {
      "id": "abc123",
      "type": "error_pattern",
      "title": "SQLite WAL lock timeout",
      "content": "This error occurs when..."
    },
    ...
  ]
}
```

The `intent` field is the classified query intent: `debugging`, `temporal`, `code_quality`, or `conceptual`. It is used to prefix the injected block with a context note (e.g., `_Based on your debugging query, here's relevant knowledge:_`).

The `content` field is truncated to 500 characters per entry to keep the injection compact.

---

## What the Agent Sees

When both layers fire on the first prompt, the agent's context window starts with two injected blocks (in addition to its normal system prompt):

```
## Gyst — Team Context (SessionStart)
⚠️ Team Rule: Never store API keys in .env files committed to git
📏 Convention: All DB queries use transactions
...

## Task-Relevant Context (from gyst)
Based on your debugging query, here's relevant knowledge:

### 🐛 SQLite WAL lock timeout
This error occurs when multiple processes hold write locks...

### 📏 Use parameterized queries for all DB writes
...
```

The agent reads this before generating its first response. No `recall()` call is needed.

---

## Cleanup Lifecycle

| Event | Action |
|-------|--------|
| Hook fires (any prompt) | Delete flag files older than 24h from `.gyst-sessions/` |
| `session_end` event | Delete the flag file for the current session |
| System tmpdir purge | Flag files are lost naturally — the next session starts fresh |

The flag directory and files are in `tmpdir()` (e.g., `/tmp` on Linux, `/var/folders/...` on macOS). They are never committed to version control and do not affect the knowledge base.

---

## Implementation

Source: `plugin/scripts/prompt.js`

Key variables:

| Variable | Value |
|----------|-------|
| Flag directory | `join(tmpdir(), ".gyst-sessions")` |
| Flag file | `join(flagDir, `${sessionId}-injected`)` |
| Recall timeout | 1500ms (internal `spawnSync` timeout) |
| Hook timeout | 2000ms (Claude Code hook registration) |
| Results per injection | 3 (`-n 3` flag) |
| Query character limit | 500 (first 500 chars of prompt text) |
