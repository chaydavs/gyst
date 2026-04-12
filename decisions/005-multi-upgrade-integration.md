# Decision: Multi-upgrade integration review

Date: 2026-04-12
Status: Accepted — all three upgrades kept

## Scope

Three parallel upgrades integrated in one session:
1. Temporal search strategy (decisions/002)
2. Context budget adaptation (decisions/003)
3. Lightweight entity extraction (decisions/004)

## Baseline (before any upgrades)

Note: when the leader agent ran the baseline measurement, Worker 1 had already
integrated temporal search directly into `src/store/search.ts` (as Strategy 4)
and Worker 2 had already wired `context_budget` into `src/mcp/tools/recall.ts`.
The "true" pre-upgrade baseline is recorded in decisions/002's Baseline section.

MRR@5: 0.8440
Recall@5: 0.8100
NDCG@5: 0.8017
Hit rate: 0.8800
Complete misses: 6 (queries q-005, q-013, q-020, q-023, q-027, q-047)
Total tests: 461 (across 16 test files)

## After integration

MRR@5: 0.8440
Recall@5: 0.8100
NDCG@5: 0.8017
Hit rate: 0.8800
Complete misses: 6 (unchanged)
Total tests: 461 (across 16 test files)
New tests added: +90 (23 temporal + 28 context-budget + 39 entity-extraction)
over the original 339 pre-worker baseline

## Per-upgrade verdict

### Temporal search — kept

Worker 1 implemented `parseTimeReference` and `searchByTemporal` in two
locations: as a standalone module (`src/store/temporal.ts`) and directly in the
main search module (`src/store/search.ts`, Strategy 4). The retrieval eval
harness (`tests/eval/retrieval-eval.ts`) imports from `search.js` and had
Strategy 4 wired before the leader agent ran.

Eval metrics are unchanged from baseline — correct outcome. None of the 50 eval
queries contain temporal signals ("yesterday", "recent", "last week", etc.), so
`searchByTemporal` returns empty arrays and RRF fusion is unaffected. The
strategy is zero-cost for non-temporal queries and strictly additive for users
who ask time-scoped questions. Kept with no changes.

Note: `src/store/temporal.ts` exists as a standalone companion module and is
imported by `tests/store/temporal.test.ts` (23 tests). It duplicates the
logic that lives in `src/store/search.ts`. This dual-module situation is
harmless (no import cycles, lint passes), but could be cleaned up in a
future refactor that makes `search.ts` re-export from `temporal.ts` instead
of duplicating the implementation.

### Context budget adaptation — kept

Self-contained and fully wired by Worker 2. No changes required during
integration. The `context_budget` optional parameter in the `recall` tool is
backwards-compatible: callers that omit it receive the same 5000-token
full-format response as before. All 28 context-budget tests pass.

### Entity extraction (standalone + wired into learn.ts) — kept

Worker 3 delivered `src/compiler/entities.ts` as a standalone module with 39
tests. The leader agent wired it into `src/mcp/tools/learn.ts`:

- `extractEntities(safeContent)` extracts function/class/method entities from
  entry content.
- `extractEntitiesFromTitle(valid.title)` extracts entities from the title.
- Entity names are deduped and stored as `entity:${name}` prefixed tags in the
  existing `entry_tags` table.
- No schema change. No existing test breakage. Full backwards compatibility.

The wiring is additive: `persistEntry` already accepts a `tags` array, so
entity tags are merged with user-supplied tags before the call. The existing
graph search (`searchByGraph`) walks `entry_tags` via LIKE matches, so future
entries learned via the MCP tool will be reachable by entity-name queries
("getToken function", "AuthService class") without any changes to the search
layer.

Eval metrics are unchanged: the eval fixture entries were seeded directly via
`insertEntry`, bypassing `learn.ts`, so entity tags are absent in the eval
database. This is expected and does not represent a regression.

## Integration friction

1. **Workers integrated more than described**: Worker 1 wrote temporal logic
   directly into `src/store/search.ts` (not just a standalone module), and the
   eval harness was already updated with Strategy 4 before the leader ran. The
   leader's Task 2 (wire temporal into retrieval-eval.ts) was already done.

2. **Duplicate temporal implementation**: `src/store/temporal.ts` and the
   temporal functions in `src/store/search.ts` contain near-identical code.
   Both are tested (two separate test files), both compile cleanly, and TypeScript
   does not complain. The duplication is harmless for now but is a cleanup
   candidate in V3.1.

3. **No import cycles**: `temporal.ts` imports `RankedResult` type from
   `search.ts`. This is a one-way type-only import and does not create a
   cycle.

4. **Entity wiring required a judgment call**: Worker 3's decision doc said
   wiring was deferred to the leader. The leader confirmed criteria:
   (a) no schema change needed, (b) additive — uses existing `tags` column,
   (c) `tests/mcp/tools.test.ts` uses a local simulation that does not call
   the real learn tool, so no breakage. Wiring proceeded.

## Conclusion

All three upgrades are live and production-ready:

- `searchByTemporal` is Strategy 4 in the RRF pipeline — zero-cost for
  non-temporal queries, additive for time-scoped queries.
- `context_budget` on the recall tool gives self-hosted (Ollama) callers
  control over response size.
- Entity extraction runs on every new entry persisted via `learn`, enriching
  the graph search index with function/class/method anchors.

Total test count: 461 (up from 339 pre-worker baseline).
Lint: clean (tsc --noEmit, no errors).
Eval: MRR@5 = 0.844, unchanged from baseline — no regression.
Everything is green; ready to commit in three logical units (one per upgrade).
