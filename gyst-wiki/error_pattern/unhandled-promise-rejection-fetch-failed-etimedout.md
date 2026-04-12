---
type: error_pattern
confidence: 0.83
last_confirmed: '2026-04-12T16:34:45.061Z'
sources: 3
affects:
  - src/integrations/github.ts
  - src/utils/http.ts
tags:
  - fetch
  - ETIMEDOUT
  - unhandled-rejection
  - timeout
  - network
---
# Unhandled promise rejection: fetch failed ETIMEDOUT

Unhandled promise rejections from fetch calls that time out, crashing the Bun process. Root cause: no timeout set and no .catch() handler on top-level fetch calls. Fix: (1) always set an AbortController timeout — `const controller = new AbortController(); const id = setTimeout(() => controller.abort(), 10_000); fetch(url, { signal: controller.signal })`; (2) wrap all fetch calls in try-catch; (3) add a global handler `process.on('unhandledRejection', ...)` as a last-resort safety net. Never let raw fetch calls run at the top level without error handling.

## Fix

Unhandled promise rejections from fetch calls that time out, crashing the Bun process. Root cause: no timeout set and no .catch() handler on top-level fetch calls. Fix: (1) always set an AbortController timeout — `const controller = new AbortController(); const id = setTimeout(() => controller.abort(), 10_000); fetch(url, { signal: controller.signal })`; (2) wrap all fetch calls in try-catch; (3) add a global handler `process.on('unhandledRejection', ...)` as a last-resort safety net. Never let raw fetch calls run at the top level without error handling.

## Evidence

**Affected files:**
- `src/integrations/github.ts`
- `src/utils/http.ts`

**Sources:** 3
