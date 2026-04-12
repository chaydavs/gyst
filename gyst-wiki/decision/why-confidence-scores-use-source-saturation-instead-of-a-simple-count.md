---
type: decision
confidence: 0.85
last_confirmed: '2026-04-12T16:34:45.080Z'
sources: 3
affects:
  - src/store/confidence.ts
tags:
  - confidence
  - scoring
  - decision
  - algorithm
  - knowledge-quality
---
# Why confidence scores use source saturation instead of a simple count

Decision made 2024-Q2: The saturation formula `1 - 1/(1 + sourceCount)` was chosen over a linear confidence boost per source because: (1) the marginal value of each additional confirmation decreases — going from 1 to 2 sources is more significant than going from 9 to 10; (2) the formula naturally caps at 1.0 without requiring clamping in normal cases; (3) it maps intuitively: 1 source = 50%, 3 sources = 75%, 9 sources = 90%. A linear scheme would require an arbitrary ceiling constant. The time-decay component is multiplicative so fresh entries with few sources are still flagged as uncertain.

## Evidence

**Affected files:**
- `src/store/confidence.ts`

**Sources:** 3
