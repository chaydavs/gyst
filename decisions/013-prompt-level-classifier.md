# 013 — Prompt-level classifier: three-stage pipeline

**Status:** Active. Stages 1 and 2 shipped 2026-04-16. Stage 3 deferred.
**Date:** 2026-04-16

## Context

The event-queue consumer (`src/compiler/process-events.ts`) classifies
every captured event — prompt, tool_use, plan_added, commit — to decide
whether it becomes a curated entry and at what confidence. Before this
change the classifier was a single pass of hand-rolled rules returning a
scalar `signalStrength`. Two failure modes kept biting:

1. **Duplicate bloat.** A prompt like "we always use camelCase for
   `getUserName`" sailed through the threshold every session, even when
   the KB already held ten identical conventions about the same entity.
   The downstream `store-conventions` dedupe only fires on directory
   scans, not prompt-driven paths.
2. **Opaque verdicts.** When a user asked the dashboard "why did this
   entry get promoted?" we had no answer — the signal was a number with
   no audit trail.

Both are products of the same omission: the classifier never looked at
what already existed, and it never explained itself.

## Options considered

1. **Single bigger rule engine.** Keep one-pass, add more rules that
   peek at `entries` before returning. Rejected: couples DB access into
   the formerly-pure classifier, blows up the unit-test matrix, and
   still leaves verdicts opaque.
2. **LLM-only classifier.** Send every event to Claude, return a
   structured verdict. Rejected: latency (hot path runs on every hook),
   cost at team-scale, and non-determinism in CI.
3. **Three-stage pipeline: rules → graphify rerank → optional LLM
   distill.** Rules stay pure and fast; rerank is a bounded DB query
   that only ever *suppresses* signal (never amplifies); LLM distill is
   gated on `ANTHROPIC_API_KEY` and only runs on borderline verdicts.
   Each stage emits stable rule IDs that accumulate into a verdict
   trail stored on the entry.

## Decision

Adopted **Option 3**. Concretely:

- **Stage 1** (`src/compiler/classify-event.ts`) stays pure and
  synchronous. Every branch returns `readonly ruleIds[]` plus an
  optional `reasoning` string. Rule IDs are exported from `RULE_IDS`
  so tests and the dashboard share a stable vocabulary.
- **Stage 2** (`src/compiler/classify-rerank.ts`, new) is a bounded
  SQL join against `entries` + `entry_tags` counting entity-tag
  overlap. At ≥2 overlaps we subtract 0.3 from `signalStrength` and
  tag `graph-duplicate-cluster`; at ≥5 we subtract 0.5 and tag
  `graph-suppress-bloat`. If entities exist with no cluster we tag
  `graph-novel`. The stage is a **strict suppressor** — it never
  raises signal, so applying it before the threshold gate is safe.
  Only `convention` and `error_pattern` candidates get reranked;
  decisions and learnings are inherently per-session.
- **Stage 3** (LLM distill) is deferred. The interface is reserved:
  when implemented it will accept the Stage 2 verdict, call Anthropic
  only when the verdict is borderline and `ANTHROPIC_API_KEY` is set,
  and append its own rule IDs to the same trail.
- The **verdict trail** (`ruleIds`, `signalStrength`, optional
  `reasoning`) is stamped into `entries.metadata.classifier` as JSON
  when any rule fires. The dashboard parses it in the inline detail
  view to render a "Why?" block — rule-ID chips with friendly labels,
  the numeric signal, and the LLM reasoning if present.

## Why metadata JSON, not a sidecar table

Considered a `verdict_log` table keyed on entry ID. Rejected: the trail
is write-once, read-rarely, and always fetched alongside the entry —
exactly the shape metadata already supports. A sidecar would double the
write path without buying queryability we need today. If we later want
analytics ("which rule fires most?") we can derive it from a `SELECT
json_extract(metadata, '$.classifier.ruleIds') FROM entries` query, or
add the table then.

## Outcome

- 5 new tests in `tests/compiler/classify-rerank.test.ts`; 612 tests
  pass across compiler/store/mcp/cli/dashboard.
- Dashboard inline detail now renders a "Why?" block when the trail
  exists. Noise-free for hand-authored entries (no rule IDs = no block).
- Ready for Task 0 (200-row labelled fixture corpus) and Task 4 (bloat
  regression gate) to land on top.

## Reversal criteria

Walk back to a single-stage classifier if either:

- The Stage 2 query's cost becomes material at scale. Budget: <2 ms per
  event at p99 on a 100k-entry KB. The `LIMIT DUP_SUPPRESS_THRESHOLD + 1`
  in `countEntityOverlap` is the guardrail; if the plan drifts off that
  index, this ADR needs a rewrite.
- The rerank begins to misfire and suppress genuinely-novel entries.
  The `graph-novel` tag exists partly to detect this — a spike in
  `graph-novel`-tagged entries that users later downvote means the
  entity extractor is noisier than the rerank assumed, and Stage 2
  should be disabled until fixed rather than patched in place.

Stage 3 will get its own ADR if/when it ships.
