# Prompt-Level Classifier — Research & Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current regex-based `classify-event` signal estimator with a research-grounded, prompt-aware classifier that reasons about *why* an event should become a particular entry type. Eliminate the "100 identical conventions" bloat by consolidating at classification time, not just at storage time, and produce a reasoning trail the dashboard can surface.

**Non-goal:** Throwing out the rule layer. Rules remain the fast path. The plan adds a *second pass* that uses graphify signals + LLM distillation (when `ANTHROPIC_API_KEY` is present) to break ties and suppress duplicates.

**Tech Stack:** Bun, TypeScript strict, bun:sqlite, @modelcontextprotocol/sdk, graphify adjacent index, optional Anthropic SDK.

---

## Why now

Current failure modes observed on the user's own DB (Apr 16):
1. **Bloat** — a single "use camelCase for functions" convention registered per directory → 100+ rows on a mid-size repo. Partially fixed in `store-conventions.ts` by cross-directory consolidation; the classifier itself still emits per-prompt duplicates that never reach `store-conventions`.
2. **Mis-typing** — `custom_errors` category stored as generic `convention` until the Apr 16 category→type mapping landed. Symptom class of a broader issue: the classifier does not distinguish "team describes how code is written" from "team describes what breaks".
3. **No reasoning trail** — dashboard nodes show `convention` vs `error_pattern` but the user has no way to ask "why was this classified as X?". Entries below the 0.15 confidence cutoff vanish with no breadcrumb.
4. **No prompt context** — classifier only sees the tool payload (error text, file path, etc.). The user's *prompt* — "we always use camelCase", "never use await in hot loops" — is the richest supervision signal and currently only feeds the `enrichPayload` promptContext extractor, not the verdict itself.

---

## Architecture

Three-stage pipeline, each stage optional:

```
event → [Stage 1: rules] → [Stage 2: graphify rerank] → [Stage 3: LLM distill] → entry
         fast, always-on    cheap, always-on             expensive, gated
```

**Stage 1 — rules (current `classify-event.ts`):** Unchanged in wire format. Emits `{candidateType, signalStrength, scopeHint, ruleId}`. New: every verdict carries an array of `ruleId` strings (the rules that fired) so downstream stages can justify a decision.

**Stage 2 — graphify rerank (new):** For `convention` and `error_pattern` candidates, query the graphify structural index for similar existing entries (cosine similarity over title + content). If ≥2 structural matches at >0.85 similarity exist, demote the signal or route to `mergeIntoExisting` instead of `insertEntry`. This is the dedup-at-classify-time fix that the consolidation step in `store-conventions.ts` approximates for scanned conventions but cannot do for prompt-driven ones.

**Stage 3 — LLM distill (new, gated):** When `ANTHROPIC_API_KEY` is set AND Stage 2 reports a tie (two candidateTypes within 0.05 signal strength), invoke a single Claude Haiku 4.5 call with the event payload + top-3 graphify neighbours and return a verdict with reasoning. The reasoning string is stored in `entries.metadata.classifierReasoning`. Budget-capped (see Task 6).

---

## File Structure

**Modify:**
- `src/compiler/classify-event.ts` — extend Classification type with `ruleIds: string[]` and `reasoning?: string`; emit ruleId on every rule path.
- `src/compiler/process-events.ts` — thread classification output through Stage 2 rerank and Stage 3 distill when gated.
- `src/compiler/store-conventions.ts` — accept and persist `classifierReasoning` in metadata when provided.
- `src/dashboard/index.html` — add a "Why?" affordance on entry nodes that opens the reasoning + rule trail.

**Create:**
- `src/compiler/classify-rerank.ts` — Stage 2; pure function taking Stage 1 verdict + graphify index handle, returning adjusted verdict.
- `src/compiler/classify-distill.ts` — Stage 3; Anthropic SDK wrapper, budget-capped, degrades gracefully when key absent.
- `src/compiler/classify-eval.ts` — offline eval harness (confusion matrix, per-type precision/recall).
- `tests/compiler/classify-rerank.test.ts` — rerank demotes duplicates, preserves novel.
- `tests/compiler/classify-distill.test.ts` — stub Anthropic client, verify budget cap.
- `tests/compiler/classify-eval.test.ts` — smoke-test the eval harness against a seeded fixture set.
- `docs/decisions/013-prompt-level-classifier.md` — ADR.
- `tests/fixtures/classifier-eval/*.jsonl` — 200-row labelled fixture corpus (prompt → expected type).

---

## Parallel Dispatch Map

Four tasks touch disjoint files and may run concurrently once Task 0 locks the fixture format:

| Agent | Task | Primary file |
|---|---|---|
| A | Task 1 (Rule verdict enrichment) | `src/compiler/classify-event.ts` |
| B | Task 2 (Stage 2 rerank) | `src/compiler/classify-rerank.ts` |
| C | Task 3 (Stage 3 distill) | `src/compiler/classify-distill.ts` |
| D | Task 4 (Eval harness + fixtures) | `src/compiler/classify-eval.ts` |

Agent E (Task 5 — pipeline wiring) depends on A/B/C types and must wait. Agent F (Task 6 — dashboard reasoning surface) depends on Task 1's `ruleIds[]` field.

---

## Task 0 — Fixture corpus (blocks all downstream)

**File:** `tests/fixtures/classifier-eval/labels.jsonl`

**Format:** One JSONL row per labelled example, 200 rows minimum:
```json
{"event_type": "prompt", "payload": {"text": "we always use camelCase for function names"}, "expected": {"candidateType": "convention", "scopeHint": "team", "subcategory": "naming"}}
```

**Sampling:** Pull real events from the user's `event_queue` (last 30 days, anonymised) + synthesize 50 adversarial examples (e.g., "we sometimes use snake_case" — should NOT classify as a team convention).

**Split:** 80/20 train/test by prompt hash. Test set is sacred — no tuning against it.

### Work Steps
- [ ] Export last 30 days of `prompt`, `tool_use`, `plan_added` events from the user's DB.
- [ ] Anonymise: strip file paths to basenames, replace identifiers via the existing `stripSensitiveData`.
- [ ] Hand-label in a Google Sheet (one sitting, ~2 hours). Column for `subcategory` (naming / error_handling / testing / etc).
- [ ] Author 50 adversarial rows targeting the bloat failure modes.
- [ ] Commit under `tests/fixtures/classifier-eval/` with a README explaining the label schema.

---

## Task 1 — Rule verdict enrichment (Agent A)

**Files:** `src/compiler/classify-event.ts`

**Contract change:**
```ts
interface Classification {
  candidateType: "convention" | "error_pattern" | ...;
  signalStrength: number;
  scopeHint: "personal" | "team" | "uncertain";
  ruleIds: readonly string[];      // NEW — every rule that fired
  reasoning?: string;              // NEW — filled by Stage 3 only
}
```

### Work Steps
- [ ] Give every rule in `classify-event.ts` a stable id (`"conv-naming-camel"`, `"err-tsc-missing-type"`, etc.).
- [ ] Accumulate matching ruleIds in the verdict; do not short-circuit on first match.
- [ ] Update all callers (`process-events.ts`) to tolerate the new field (purely additive, safe).
- [ ] Test: single payload that matches two rules surfaces both ids.

---

## Task 2 — Stage 2 rerank (Agent B)

**File:** `src/compiler/classify-rerank.ts`

Pure function signature:
```ts
export function rerankWithGraphify(
  verdict: Classification,
  payload: Record<string, unknown>,
  graphifyIndex: StructuralIndex,
): Classification;
```

**Rules:**
1. If `candidateType ∈ {convention, error_pattern}` AND graphify finds ≥2 entries at cosine ≥0.85 → reduce `signalStrength` by 0.3 (below the default 0.5 threshold) so the consumer routes to `mergeIntoExisting` instead of creating.
2. If `candidateType === convention` AND graphify finds a cluster of ≥5 entries sharing the same top entity → tag `signalStrength -= 0.2` and append `ruleId: "graph-bloat-cluster"` so the dashboard can surface "suppressed: too many similar".
3. Never amplify; rerank only demotes.

### Work Steps
- [ ] Implement the graphify similarity query using the existing `structural_nodes` / `structural_edges` tables (see `src/graphify/`).
- [ ] Unit test: 10 canned verdict+payload fixtures covering each rule.
- [ ] Integration test: seed a DB with 6 near-duplicate conventions, confirm the 6th is demoted.

---

## Task 3 — Stage 3 LLM distill (Agent C)

**File:** `src/compiler/classify-distill.ts`

**Gate:** `process.env.ANTHROPIC_API_KEY` present AND Stage 2 verdict has `signalStrength` within ±0.05 of a second candidate (tie).

**Prompt:** Haiku 4.5, temperature 0, max 300 tokens out:
```
You are a classifier for an engineering-team knowledge base. Given this event payload and the top-3 similar existing entries, output JSON { "type": "convention"|"error_pattern"|"decision"|"learning", "reasoning": "..." }.
```

**Budget:** hard cap at 50 distill calls per `processEvents` invocation; log+skip past the cap.

### Work Steps
- [ ] Add `@anthropic-ai/sdk` dependency (already transitively available via MCP SDK? verify).
- [ ] Implement the wrapper with try/catch that falls back to Stage 2 verdict on any network error.
- [ ] Unit test: stub the SDK client, confirm the retry/budget logic.
- [ ] Dormant path test: without `ANTHROPIC_API_KEY` the function must return the input unchanged — no network call.

---

## Task 4 — Eval harness (Agent D)

**File:** `src/compiler/classify-eval.ts`

CLI: `bun run eval:classifier` — reads `tests/fixtures/classifier-eval/labels.jsonl`, runs the full pipeline with Stage 3 disabled (for determinism), prints:
- Confusion matrix (actual × predicted type).
- Per-type precision, recall, F1.
- Top 10 mis-classifications with ruleIds surfaced.
- Bloat score: `(#entries_created - #unique_expected) / #events_processed`. Target <0.05.

### Work Steps
- [ ] Implement the runner using the existing `classifyEvent` export.
- [ ] Add `"eval:classifier"` to `package.json` scripts.
- [ ] Commit baseline metrics to `docs/metrics/2026-04-16-classifier-baseline.json`.
- [ ] Establish the regression threshold: CI fails if F1 drops >5% from baseline.

---

## Task 5 — Pipeline wiring (depends on 1/2/3)

**File:** `src/compiler/process-events.ts`

### Work Steps
- [ ] Thread `ruleIds` and `reasoning` through `createEntryFromEvent` into the metadata JSON.
- [ ] Call `rerankWithGraphify` after Stage 1, before the threshold check.
- [ ] Call `distillWithLLM` only when the tie condition holds AND the key is set.
- [ ] Re-run `bun run eval:classifier` — bloat score must drop below 0.05 in the eval set.

---

## Task 6 — Dashboard reasoning surface (depends on 1)

**File:** `src/dashboard/index.html`

### Work Steps
- [ ] Parse `metadata.ruleIds[]` and `metadata.classifierReasoning` out of the entry row.
- [ ] In the inline detail view (the one that replaced the side panel on Apr 16), add a "Why?" section listing the rule ids with friendly names and, when present, the LLM reasoning quote.
- [ ] E2E test: a seeded entry with ruleIds renders the section; an entry without renders "classified by defaults".

---

## Risks

1. **LLM cost creep** — 50 calls × ~1k tokens × Haiku pricing = <$0.01 per processEvents invocation, but unbounded if process runs in a loop. Mitigation: invocation-scoped budget AND daily cap enforced in `src/utils/config.ts`.
2. **Eval set drift** — labels age fast for a living codebase. Mitigation: regenerate every 90 days; baseline file gets replaced not edited.
3. **Graphify index cold start** — first run on a fresh clone has an empty structural index, so Stage 2 is a no-op. Document this; the existing `gyst sync-graph` command is the remediation.
4. **Backward-compat** — new metadata fields must be optional; existing entries must render without crashing the dashboard. Covered by the `reasoning?: string` marker.

---

## Success Criteria

- [ ] Bloat score <0.05 on the eval set.
- [ ] Per-type F1 ≥ baseline for all 5 types (`error_pattern`, `convention`, `decision`, `learning`, `ghost_knowledge`).
- [ ] Dashboard "Why?" view renders for ≥95% of entries created post-merge.
- [ ] Zero new `database is locked` failures in the integration test suite (Stage 3 must not add contention).
- [ ] ADR `013-prompt-level-classifier.md` merged.
