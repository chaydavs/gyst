---
type: convention
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.070Z'
sources: 5
affects:
  - tests/store/search.test.ts
  - tests/compiler/extract.test.ts
tags:
  - testing
  - convention
  - bun-test
  - naming
  - structure
---
# Test structure: describe/it nesting and naming pattern

Tests use two-level nesting: outer describe is the module/function name, inner it describes the specific behavior: `describe('searchByBM25', () => { it('returns empty array for empty query', ...) })`. Test names must be full sentences starting with a verb. Group happy path, edge cases, and error cases within the same describe block. One assertion per test when possible — use multiple expect() calls only for related assertions. Use `test.each` for parameterized cases.

## Evidence

**Affected files:**
- `tests/store/search.test.ts`
- `tests/compiler/extract.test.ts`

**Sources:** 5
