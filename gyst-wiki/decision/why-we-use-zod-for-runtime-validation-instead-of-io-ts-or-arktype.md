---
type: decision
confidence: 0.86
last_confirmed: '2026-04-12T16:34:45.079Z'
sources: 4
affects:
  - src/compiler/extract.ts
  - package.json
tags:
  - zod
  - validation
  - typescript
  - decision
  - library
---
# Why we use Zod for runtime validation instead of io-ts or ArkType

Decision made 2024-Q1: Zod chosen because: (1) TypeScript-first with excellent type inference — inferred types match runtime behavior exactly; (2) the best developer experience of any validation library — error messages are actionable; (3) v4 released 2025 with 14x performance improvement and reduced bundle size; (4) massive ecosystem adoption means community support and integrations are mature. io-ts was evaluated but rejected due to steep learning curve (functional programming style). ArkType is impressive but not battle-tested at scale as of decision date. Revisit ArkType in 2026.

## Evidence

**Affected files:**
- `src/compiler/extract.ts`
- `package.json`

**Sources:** 4
