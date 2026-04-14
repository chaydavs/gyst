---
type: convention
confidence: 0.5
last_confirmed: '2026-04-14T05:27:12.832Z'
sources: 1
affects:
  - src/server/http.ts
---
# Use async/await not callbacks

Always use async/await. Callbacks cause callback hell and are harder to reason about.

## Evidence

**Affected files:**
- `src/server/http.ts`

**Sources:** 1
