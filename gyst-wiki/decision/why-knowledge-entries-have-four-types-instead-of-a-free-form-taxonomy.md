---
type: decision
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.080Z'
sources: 5
affects:
  - src/store/database.ts
  - src/compiler/extract.ts
tags:
  - knowledge-types
  - taxonomy
  - decision
  - architecture
  - types
---
# Why knowledge entries have four types instead of a free-form taxonomy

Decision made 2024-Q1: Four fixed types (error_pattern, convention, decision, learning) chosen over free-form tags because: (1) AI agents can predict type reliably — it's a 4-way classification vs. open taxonomy; (2) each type has a different confidence decay half-life that maps to real-world stale rates; (3) type-filtered search dramatically reduces noise; (4) the four types cover the majority of team knowledge: what broke and how to fix it, how we do things, why we made choices, and what we discovered. Free-form types were prototyped and led to an inconsistent taxonomy within 2 weeks.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `src/compiler/extract.ts`

**Sources:** 5
