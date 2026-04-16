# Graph Report - .  (2026-04-16)

## Corpus Check
- 147 files · ~208,698 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 661 nodes · 1242 edges · 74 communities detected
- Extraction: 67% EXTRACTED · 33% INFERRED · 0% AMBIGUOUS · INFERRED: 408 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]

## God Nodes (most connected - your core abstractions)
1. `initDatabase()` - 28 edges
2. `insertEntry()` - 24 edges
3. `main()` - 21 edges
4. `loadConfig()` - 21 edges
5. `registerAllTools()` - 18 edges
6. `canLoadExtensions()` - 18 edges
7. `initVectorStore()` - 15 edges
8. `runHybridSearch()` - 15 edges
9. `addManualEntry()` - 14 edges
10. `main()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `makeDb()` --calls--> `initDatabase()`  [INFERRED]
  tests/cli/ghost-init.test.ts → src/store/database.ts
- `makeDb()` --calls--> `initDatabase()`  [INFERRED]
  tests/uniformity/onboard.test.ts → src/store/database.ts
- `runConsolidate()` --calls--> `consolidate()`  [INFERRED]
  tests/compiler/consolidate.test.ts → src/compiler/consolidate.ts
- `evaluate()` --calls--> `runHybridSearch()`  [INFERRED]
  tests/benchmark/codememb/ablation.ts → src/store/hybrid.ts
- `main()` --calls--> `initDatabase()`  [INFERRED]
  tests/benchmark/codememb/ablation.ts → src/store/database.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (54): initActivitySchema(), initTeamSchema(), calibrate(), loadConfig(), consolidate(), deleteMarkdownFile(), prunePhysicalFiles(), stage1Decay() (+46 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (22): registerActivityTool(), formatAge(), registerCheckConventionsTool(), registerCheckTool(), registerConventionsTool(), withRetry(), registerFailuresTool(), registerFeedbackTool() (+14 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (35): computeNdcg(), evaluate(), main(), mean(), logActivity(), seedDevEntry(), runDevSession(), seedCodeEntry() (+27 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (37): retrieveTopK(), bm25RankedIds(), runHybridSearch(), applyIntentBoost(), classifyIntent(), expandQuery(), computeMeanNdcg(), computeMeanPrecision() (+29 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (33): authenticateRequest(), AuthError, createInviteKey(), createTeam(), generateApiKey(), joinTeam(), verifyApiKey(), compareMetric() (+25 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (27): computeMRR(), makePaymentsEntry(), weekMRR(), findDuplicate(), jaccardSimilarity(), loadTagsAndFiles(), mergeEntries(), deduplicate() (+19 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (25): parseLatestCommit(), getClusters(), getFileSubgraph(), getFullGraph(), getNeighbors(), recordCoRetrieval(), strengthenCoRetrievedLinks(), setupGraphDb() (+17 more)

### Community 7 - "Community 7"
Cohesion: 0.16
Nodes (17): GystEmbeddingModel, main(), Dense retrieval by cosine similarity. Returns BEIR-style run dict     {qid: {did, Spawns `bun run pipeline-eval.ts` with stdin={corpus,queries}, reads     stdout=, Thin adapter over sentence-transformers all-MiniLM-L6-v2.      Same model Gyst u, Compute NDCG@k, Recall@k, MAP using pytrec_eval — independent of BEIR., retrieve_embedding(), run_embedding_only() (+9 more)

### Community 8 - "Community 8"
Cohesion: 0.25
Nodes (16): askYesNo(), checkBunVersion(), detectTools(), hasCli(), initProject(), installGitHooks(), mergeClaudeHooks(), mergeGeminiHooks() (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.21
Nodes (13): anyMatch(), classifyCommit(), classifyEvent(), classifyPrompt(), classifyToolUse(), emitEvent(), getPendingEvents(), markEventCompleted() (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.27
Nodes (12): checkCustomErrors(), checkErrorHandling(), checkExports(), checkFileNaming(), checkFileViolations(), checkImportsOrder(), checkNaming(), dispatchConvention() (+4 more)

### Community 11 - "Community 11"
Cohesion: 0.24
Nodes (12): analyseFile(), checkImportsOrdered(), clamp01(), countImportLines(), countMatches(), detectForDirectory(), isTestContext(), buildContent() (+4 more)

### Community 12 - "Community 12"
Cohesion: 0.32
Nodes (10): ingestHaystack(), parseLmeDate(), scoreRetrieval(), sessionToEntry(), aggregate(), main(), num(), parseArgs() (+2 more)

### Community 13 - "Community 13"
Cohesion: 0.33
Nodes (11): computeNdcg(), computePrecision(), computeRecall(), computeReciprocalRank(), evaluateConfig(), fmt(), main(), padLeft() (+3 more)

### Community 14 - "Community 14"
Cohesion: 0.35
Nodes (11): buildConventions(), buildErrorPatterns(), buildGettingStarted(), buildHeader(), buildRecentDecisions(), buildTeamRules(), extractCategory(), firstSentence() (+3 more)

### Community 15 - "Community 15"
Cohesion: 0.35
Nodes (9): buildEntries(), buildQueries(), buildQuery(), distinctiveWords(), main(), pick(), pickN(), randInt() (+1 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (5): DatabaseError, GystError, SearchError, SecurityError, ValidationError

### Community 17 - "Community 17"
Cohesion: 0.2
Nodes (0): 

### Community 18 - "Community 18"
Cohesion: 0.46
Nodes (7): extractFixLine(), formatCompact(), formatForContext(), formatFull(), formatMinimal(), formatUltraMinimal(), splitSentences()

### Community 19 - "Community 19"
Cohesion: 0.32
Nodes (4): constructDistillationPrompt(), createEntryFromDistillation(), distillEvents(), distillWithLlm()

### Community 20 - "Community 20"
Cohesion: 0.25
Nodes (2): logAccess(), startDashboardServer()

### Community 21 - "Community 21"
Cohesion: 0.57
Nodes (6): fmtNum(), fmtPct(), main(), printHeader(), readLongMem(), tryRead()

### Community 22 - "Community 22"
Cohesion: 0.48
Nodes (5): computeCoverage(), computeFreshness(), computeGhost(), computeStyle(), computeUniformityScore()

### Community 23 - "Community 23"
Cohesion: 0.47
Nodes (4): insertEntry(), insertTag(), makeDb(), seedDb()

### Community 24 - "Community 24"
Cohesion: 0.4
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 0.4
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 0.4
Nodes (0): 

### Community 27 - "Community 27"
Cohesion: 0.7
Nodes (4): fetchEntriesByIds(), getEntryById(), mapRow(), scopeVisibilityClause()

### Community 28 - "Community 28"
Cohesion: 0.5
Nodes (1): makeDb()

### Community 29 - "Community 29"
Cohesion: 0.5
Nodes (0): 

### Community 30 - "Community 30"
Cohesion: 0.67
Nodes (2): compareEntries(), tierOf()

### Community 31 - "Community 31"
Cohesion: 0.5
Nodes (0): 

### Community 32 - "Community 32"
Cohesion: 0.5
Nodes (0): 

### Community 33 - "Community 33"
Cohesion: 1.0
Nodes (2): ids(), inTop()

### Community 34 - "Community 34"
Cohesion: 0.67
Nodes (0): 

### Community 35 - "Community 35"
Cohesion: 0.67
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 0.67
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (2): daysAgo(), hoursAgo()

### Community 38 - "Community 38"
Cohesion: 0.67
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (0): 

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (0): 

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (0): 

### Community 52 - "Community 52"
Cohesion: 1.0
Nodes (0): 

### Community 53 - "Community 53"
Cohesion: 1.0
Nodes (0): 

### Community 54 - "Community 54"
Cohesion: 1.0
Nodes (0): 

### Community 55 - "Community 55"
Cohesion: 1.0
Nodes (0): 

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (0): 

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (0): 

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (0): 

### Community 59 - "Community 59"
Cohesion: 1.0
Nodes (0): 

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (0): 

### Community 61 - "Community 61"
Cohesion: 1.0
Nodes (0): 

### Community 62 - "Community 62"
Cohesion: 1.0
Nodes (0): 

### Community 63 - "Community 63"
Cohesion: 1.0
Nodes (0): 

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (0): 

### Community 65 - "Community 65"
Cohesion: 1.0
Nodes (0): 

### Community 66 - "Community 66"
Cohesion: 1.0
Nodes (0): 

### Community 67 - "Community 67"
Cohesion: 1.0
Nodes (0): 

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (0): 

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (0): 

### Community 70 - "Community 70"
Cohesion: 1.0
Nodes (0): 

### Community 71 - "Community 71"
Cohesion: 1.0
Nodes (0): 

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (0): 

### Community 73 - "Community 73"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **4 isolated node(s):** `Thin adapter over sentence-transformers all-MiniLM-L6-v2.      Same model Gyst u`, `Compute NDCG@k, Recall@k, MAP using pytrec_eval — independent of BEIR.`, `Dense retrieval by cosine similarity. Returns BEIR-style run dict     {qid: {did`, `Spawns `bun run pipeline-eval.ts` with stdin={corpus,queries}, reads     stdout=`
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 39`** (2 nodes): `fetchEntries()`, `cross-tool.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (2 nodes): `readFixture()`, `harvest.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (2 nodes): `toolHandler()`, `dispatcher-instrument.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (2 nodes): `makeEntry()`, `learn.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (2 nodes): `makeConvention()`, `store-conventions.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (2 nodes): `makeEntry()`, `intent.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (2 nodes): `seedConvention()`, `check-violations.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (2 nodes): `writer.test.ts`, `makeEntry()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (2 nodes): `validInput()`, `extract.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (2 nodes): `makeEntry()`, `format-compat.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (2 nodes): `makeFactors()`, `confidence.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (2 nodes): `makeEntry()`, `database.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (2 nodes): `generateSessionContext()`, `session-inject.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (2 nodes): `renderRecap()`, `recap.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (2 nodes): `calculateConfidence()`, `confidence.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (1 nodes): `full-lifecycle.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (1 nodes): `install.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `export.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `recap.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `dashboard.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (1 nodes): `security.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (1 nodes): `classify-event.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (1 nodes): `parsers.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (1 nodes): `normalize.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (1 nodes): `graphify-transformer.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (1 nodes): `process-events.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 65`** (1 nodes): `distill.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 66`** (1 nodes): `sessions-schema.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (1 nodes): `concurrency.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (1 nodes): `query-expansion.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (1 nodes): `rebuild.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (1 nodes): `session-end.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 71`** (1 nodes): `tool-use.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (1 nodes): `prompt.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 73`** (1 nodes): `gemini-adapter.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `main()` connect `Community 0` to `Community 1`, `Community 2`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Why does `insertEntry()` connect `Community 2` to `Community 0`, `Community 1`, `Community 3`, `Community 5`, `Community 6`, `Community 7`, `Community 12`, `Community 13`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `initDatabase()` connect `Community 0` to `Community 2`, `Community 3`, `Community 6`, `Community 7`, `Community 8`, `Community 12`, `Community 13`, `Community 23`, `Community 28`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `initDatabase()` (e.g. with `main()` and `runBenchmark()`) actually correct?**
  _`initDatabase()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 22 inferred relationships involving `insertEntry()` (e.g. with `main()` and `runBenchmark()`) actually correct?**
  _`insertEntry()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `main()` (e.g. with `initDatabase()` and `insertEntry()`) actually correct?**
  _`main()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 20 inferred relationships involving `loadConfig()` (e.g. with `main()` and `calibrate()`) actually correct?**
  _`loadConfig()` has 20 INFERRED edges - model-reasoned connections that need verification._