# Decision: 007 — Ghost Knowledge: Tribal Team Rules as a First-Class Entry Type

Date: 2026-04-11
Status: Accepted

## Context

Every team has knowledge that never makes it into docs, linters, or README files:

- "Never deploy on Fridays after 3pm — three incidents have happened"
- "Don't touch `src/billing/reconcile.ts` without asking Sarah"
- "New hires always break the build by importing directly from `src/server/auth.ts`"

These rules live entirely in people's heads. When a developer leaves or a new hire
joins, this knowledge evaporates or is learned the expensive way — through incidents,
frustrated Slack threads, or a senior engineer's exasperated comment on a PR.

Gyst already captures structured knowledge (conventions, decisions, error patterns,
learnings) but all four types require the AI agent to *observe* the knowledge through
code commits, errors, and feedback. Ghost knowledge is different: it must be
**actively elicited** from humans who hold it.

Additionally, the existing four types are all subject to confidence decay — a convention
from 2 years ago might be outdated. Ghost knowledge (things like "do not deploy on
Fridays") is fundamentally timeless: it stays true until someone explicitly removes it.
Using a finite half-life for these entries would cause them to fade from recall results
even though they are as important as ever.

## Baseline (before change)

From `tests/eval/results.json`:

| Metric | Value |
|--------|------:|
| MRR@5 | 0.9767 |
| Recall@5 | 0.9833 |
| NDCG@5 | 0.9624 |
| Hit rate | 1.000 |
| Complete misses | 0 / 50 |

429 tests passing, 0 type errors.

## Change

### 1. New entry type: `ghost_knowledge`

Added `'ghost_knowledge'` to the `type` CHECK constraint in the `entries` table
(`src/store/database.ts`). This is a non-breaking additive change — existing entries
are unaffected and no migration is required because the constraint only applies to
`INSERT` and `UPDATE` operations.

### 2. Infinite confidence half-life

Added `ghost_knowledge: Infinity` to `HALF_LIFE_DAYS` in `src/store/confidence.ts`.

`0.5 ** (days / Infinity) === 1` for any finite `days` value — confirmed by JavaScript
semantics. This means ghost knowledge entries never decay in `calculateConfidence`,
regardless of how long ago they were created or confirmed.

Confidence defaults to `1.0` for ghost knowledge entries (overriding the usual `0.5`
default) in `src/compiler/extract.ts`. An explicit `confidence` override is still
accepted if provided.

### 3. Schema validation

`LearnInputSchema` and `KnowledgeEntrySchema` in `src/compiler/extract.ts` now include
`"ghost_knowledge"` in their `type` enum. The `extractEntry` function:
- Skips `normalizeErrorSignature` and `generateFingerprint` for `ghost_knowledge`
  entries (error normalization is only meaningful for `error_pattern`).
- Defaults `scope` to `"team"` (ghost knowledge is always team-wide).
- Defaults `confidence` to `1.0`.

### 4. Recall boost and forced visibility

In `src/mcp/tools/recall.ts`:
- `RecallInput.type` enum extended to include `"ghost_knowledge"`.
- After RRF fusion, ghost knowledge entries receive a `+0.1` score boost (capped at
  1.0) and the list is re-sorted. This ensures they surface in the top results even
  when BM25/vector retrieval didn't rank them highest.
- Ghost knowledge entries bypass the `confidenceThreshold` filter. Their confidence is
  1.0 by spec, but the explicit bypass prevents a misconfigured threshold from hiding
  them.
- Ghost knowledge entry titles are prefixed with `⚠️ Team Rule: ` in formatted output
  so agents immediately recognise mandatory constraints.

### 5. Interactive CLI onboarding: `gyst ghost-init`

New command `src/cli/ghost-init.ts` walks a developer through 7 curated questions:

1. What's something every new hire learns the hard way?
2. Are there sacred files that should never be modified without checking?
3. What deployment rules aren't written down?
4. What past technical decisions should new people know about?
5. What patterns don't appear in the linter or style guide?
6. Is there anything that looks like it should be changed but shouldn't be?
7. What's the most common first-month mistake?

Each non-empty answer is stored as a `ghost_knowledge` entry. File paths are extracted
from answers automatically (regex `[\w\-./]+\.\w{1,6}`), tagging the entry to the
relevant source files.

Wired into `src/cli/index.ts` as `gyst ghost-init`.

## Result (after change)

Test count: 429 + new ghost-init tests (see `tests/cli/ghost-init.test.ts`).
Type errors: 0.
Lint: passing.

The retrieval metrics are unchanged — ghost knowledge is additive. The boost and
prefix only affect how ghost entries are ranked relative to others; they do not
alter the benchmark's labelled queries which don't include ghost knowledge entries.

## Decision

**Accepted.** Ghost knowledge fills a genuine gap that no amount of retrieval
algorithm improvement can address: knowledge that has never been written down anywhere.
The infinite half-life and recall boost ensure these team rules are always visible to
AI agents at the moment they matter most — right before the agent takes an action
that the team has explicitly flagged as dangerous or incorrect.

The interactive CLI is the critical enabler: without a structured elicitation flow,
ghost knowledge stays in people's heads. The 7 questions are drawn from real patterns
in post-mortems, team retrospectives, and onboarding anti-patterns.

## Follow-ups not done in this commit

- **Question set expansion**: The 7 questions are a starting point. A richer set
  (20–30 questions) could be developed from reviewing real team retrospectives.
- **Confirmation workflow**: Ghost knowledge entries currently have no review mechanism.
  A `gyst ghost-review` command that presents existing entries for team confirmation
  would help keep them accurate over time.
- **Per-question tags**: Currently all ghost entries get `["ghost", question_id]`. A
  richer tagging strategy (inferring domain tags from content) would improve recall
  precision for large ghost knowledge collections.
- **Import from existing docs**: A `gyst ghost-import <file>` command that reads
  an existing runbook or README and extracts ghost-knowledge-style entries could
  populate the knowledge base without requiring interactive sessions.
