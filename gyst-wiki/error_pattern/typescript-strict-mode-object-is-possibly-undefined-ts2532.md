---
type: error_pattern
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.064Z'
sources: 5
affects:
  - tsconfig.json
  - src/store/search.ts
tags:
  - typescript
  - strict-mode
  - TS2532
  - undefined
  - type-safety
---
# TypeScript strict mode: Object is possibly undefined (TS2532)

TS2532 fires when accessing array elements by index (`arr[0]`) or dictionary properties without narrowing. With strict mode and noUncheckedIndexedAccess, arr[0] returns T | undefined. Fix: (1) use arr.at(0) with an explicit undefined check; (2) destructure with a default: `const [first = defaultValue] = arr`; (3) use optional chaining `arr[0]?.property`. Never cast with `arr[0]!` unless you can prove the array is non-empty. Add `noUncheckedIndexedAccess: true` to tsconfig for maximum safety.

## Fix

TS2532 fires when accessing array elements by index (`arr[0]`) or dictionary properties without narrowing. With strict mode and noUncheckedIndexedAccess, arr[0] returns T | undefined. Fix: (1) use arr.at(0) with an explicit undefined check; (2) destructure with a default: `const [first = defaultValue] = arr`; (3) use optional chaining `arr[0]?.property`. Never cast with `arr[0]!` unless you can prove the array is non-empty. Add `noUncheckedIndexedAccess: true` to tsconfig for maximum safety.

## Evidence

**Affected files:**
- `tsconfig.json`
- `src/store/search.ts`

**Sources:** 5
