# Confidence Scoring

## Overview

Every knowledge entry in Gyst has a `confidence` score between `0.0` and `1.0`. It answers a single question: **how much should an agent trust this entry right now?**

Confidence isn't set manually — it's computed from four observable factors and updated automatically as the knowledge base evolves. Entries below the recall threshold (`0.15` by default) are excluded from all search results.

**Source**: `src/store/confidence.ts` — `calculateConfidence(factors: ConfidenceFactors): number`

---

## The Formula

```
saturation  = 1 - 1 / (1 + sourceCount)
decay       = 0.5 ^ (daysSinceLastConfirmed / halfLife)
raw         = saturation × decay
penalised   = raw
              × (hasContradiction ? 0.5 : 1.0)
              × (codeChanged      ? 0.7 : 1.0)
result      = clamp(penalised, 0.0, 1.0)
```

---

## Factor 1: Source Saturation

**Question:** How many independent sources have confirmed this entry?

```
saturation = 1 - 1 / (1 + sourceCount)
```

Each new confirmation increases confidence, but with diminishing returns — the marginal value of each additional source halves. This prevents a single high-frequency hook from inflating confidence to 1.0 just by firing repeatedly.

| Source count | Saturation |
|---|---|
| 1 | 0.50 — a single observation |
| 2 | 0.67 |
| 3 | 0.75 |
| 7 | 0.875 |
| 9 | 0.90 — highly confirmed |

A brand-new entry with `source_count = 1` starts at saturation `0.5`.

---

## Factor 2: Time Decay

**Question:** How recently was this entry confirmed as still accurate?

```
decay = 0.5 ^ (daysSinceLastConfirmed / halfLife)
```

After exactly one half-life, the decay factor is `0.5`. The half-life is type-specific because different knowledge types age at different rates:

| Type | Half-life | Rationale |
|---|---|---|
| `ghost_knowledge` | ∞ (no decay) | Timeless team constraints — true until explicitly removed |
| `convention` | 9,999 days | Stable until explicitly changed; functionally permanent |
| `decision` | 365 days | Architectural choices drift slowly, remain relevant for months |
| `learning` | 60 days | Observations fade as codebase and context evolve |
| `error_pattern` | 30 days | Fixes go stale quickly as code changes |
| `structural` / `md_doc` | none | Hash-gated updates; no time decay applied |

**Example:** A `learning` entry confirmed today has `decay = 1.0`. After 60 days without re-confirmation, `decay = 0.5`. After 120 days, `decay = 0.25` — likely below recall threshold.

---

## Factor 3: Contradiction Penalty (×0.5)

**Question:** Does another entry in the knowledge base disagree with this one?

When two active entries contradict each other, the conflicted entry's confidence is halved. This signals human review is needed before the entry should be trusted. The entry's `status` also transitions to `conflicted`.

Removing or archiving the contradicting entry restores normal confidence calculation.

---

## Factor 4: Code-Changed Penalty (×0.7)

**Question:** Has the source file this entry describes been modified since the entry was created?

When the referenced source file changes, confidence drops by 30%. The entry isn't necessarily wrong — the code it describes has simply evolved and re-verification is warranted. This is a soft signal, not a hard invalidation.

The penalty is checked via `entries.source_file_hash` compared against the current file hash at consolidation time.

---

## Initial Confidence Values

| Entry origin | Starting confidence |
|---|---|
| `learn` tool | `0.5` |
| Ghost knowledge | `1.0` (fixed — never decays, penalties don't apply) |
| Structural entries (auto-generated) | `0.8` |

---

## Confidence Adjustments After Creation

| Event | Change |
|---|---|
| Re-confirmation / merge | `source_count + 1`, `last_confirmed` updated, score recomputed |
| `feedback` tool — helpful | `+0.02` (capped at 1.0) |
| `feedback` tool — unhelpful | `−0.05` (floored at 0.0) |
| Consolidation decay pass | Full recompute from formula |

---

## Recall Threshold

Entries with `confidence < 0.15` (configurable via `config.confidenceThreshold`) are excluded from all recall results. They remain in the database — they surface in the dashboard review queue for confirmation or archival.

Ghost knowledge entries bypass this threshold entirely and always appear in tier 0 search results.

---

## Confidence and the Review Queue

Entries below `0.4` confidence that haven't been confirmed in 30+ days surface in the dashboard's **Review Queue**. The queue lets a human either:
- **Confirm** — bumps `source_count`, updates `last_confirmed`, raises confidence
- **Archive** — sets `status = 'archived'`, permanently removes from recall

This is the primary mechanism for pruning a KB that's drifting stale. See also: [AI Drift Detection](./drift-detection.md) — the drift system tracks how many stale entries exist and whether the zero-result rate is rising.

---

## Worked Example

An `error_pattern` entry confirmed once, 45 days ago, with no contradictions and no code change:

```
saturation  = 1 - 1/(1+1) = 0.50
halfLife    = 30 days
decay       = 0.5 ^ (45/30) = 0.5 ^ 1.5 ≈ 0.354
raw         = 0.50 × 0.354 = 0.177
penalised   = 0.177 × 1.0 × 1.0 = 0.177
```

Score: `0.177` — just above the recall threshold. If it goes unconfirmed another ~15 days, it will drop below `0.15` and disappear from search results. The review queue will surface it before that happens.
