# Gyst 3-Minute Demo

## Setup (before)

- Real project open — not a toy repo. Use a project with at least a few months of git history, a CLAUDE.md or README, and some TypeScript/JavaScript source files.
- No `.gyst` directory yet — confirm with `ls -la | grep gyst` (should show nothing)
- Terminal + editor side by side. Dashboard tab ready to open.
- Internet connection not required — everything is local.

---

## [0:00–0:30] The Problem

**What to say:**

> "Every AI coding agent on your team starts each session knowing nothing. Your agent figured out last week why deploys fail on Fridays — gone. Someone's agent learned the right way to structure API responses — gone. The knowledge disappears every time the session closes. Your agents get faster, but your team never gets smarter."

**What to show:**

Open a new Claude Code session in the project. Show the blank context — no CLAUDE.md loaded, no conventions injected. Ask:

```
What are the conventions for this codebase?
```

Point out: the agent says it doesn't know, or makes something up. This is the problem.

---

## [0:30–1:15] The Fix — gyst init

**What to say:**

> "Gyst builds a context layer from your existing codebase — git history, code comments, markdown docs, your most-edited files. Then it injects that context into every agent session automatically. Zero config. 90 seconds."

**What to run:**

```bash
npm install -g gyst-mcp && gyst init
```

**What to point out as it runs:**

Watch the ANSI progress box appear:

```
┌─────────────────────────────────────────────────────┐
│  gyst init                                          │
├─────────────────────────────────────────────────────┤
│  ✓ Database initialized      .gyst/wiki.db          │
│  ✓ MCP server registered     Claude Code            │
│  ✓ Hooks installed           post-commit            │
│  ✓ Scanning codebase ...     42 files               │
│  ✓ Loaded conventions        8 entries              │
│  ✓ Loaded decisions          3 entries              │
│  ✓ Ghost knowledge generated 5 entries              │
└─────────────────────────────────────────────────────┘
```

Point out:
- "It detected Claude Code automatically — no config editing"
- "It found 8 conventions already present in your codebase"
- "It generated 5 ghost knowledge entries — facts your team knows but never wrote down"

```bash
# Show what was captured
gyst recall "what should I know about this codebase"
```

Scroll through the output. Point out real entries extracted from the project — not generic advice.

---

## [1:15–2:15] The Experience

**What to say:**

> "Now restart Claude Code. This is the only manual step. Every session after this is automatic."

**What to show:**

Close and reopen Claude Code in the same project. Show the `SessionStart` badge in the corner — `[gyst ✓]` — confirming context was injected.

Ask the same question:

```
What are the conventions for this codebase?
```

Point out: the agent now gives specific, accurate answers from the actual codebase — the same answers a senior developer would give. No hallucination.

Ask a harder question:

```
What error patterns should I watch out for in this project?
```

If error patterns were mined, show them surfacing. Point out the confidence score — the agent knows how certain it is.

**Bonus — show the ghost knowledge appearing in a subagent:**

```
Spawn a subagent to refactor the auth module
```

Point out: the subagent also gets the ghost knowledge injected. Every agent in the session tree shares the same context.

---

## [2:15–3:00] The Durability

**What to say:**

> "This isn't a one-time thing. The context layer grows with every session. Commit something — the post-commit hook mines it. End a session — the agent's insights get distilled back in. Come back in three months and the context is richer, not staler."

**What to show:**

```bash
gyst dashboard
```

Open `localhost:3579` in the browser. Walk through three things:

1. **Feed tab** — show the entries that were just created. Point out the type colors (purple = ghost knowledge, yellow = decision, amber = convention, red = error pattern). Click one to show the full content.

2. **Context Economics section** (sidebar) — show the leverage ratio. Even after one session, it's already above 1.0. Say: "Every token Gyst delivers costs a fraction of a token to store. This ratio only goes up."

3. **Knowledge Drift section** (sidebar) — show the drift score at 0% (healthy, fresh install). Mention: "If your team stops adding knowledge, Gyst flags it. You get a warning before the context goes stale."

---

## Closing line

> "Your AI agent just got your team's memory. It'll feel different."

---

## Appendix: common objections

**"We already have CLAUDE.md"**
Gyst ingests CLAUDE.md automatically — it's one of the first things `self-document` loads. Gyst adds the layer that doesn't require humans to write and maintain it manually.

**"What if the mined knowledge is wrong?"**
Every entry has a confidence score. Low-confidence entries appear in the review queue. One click to confirm or archive. The agent can also rate entries with `feedback` — unhelpful entries decay over time.

**"Does it send our code anywhere?"**
No. Everything lives in `.gyst/wiki.db` in your project. The MCP server runs locally. No external calls unless you explicitly host a shared HTTP server for team mode.
