---
type: error_pattern
confidence: 0.5
last_confirmed: '2026-04-14T08:53:34.940Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - timeout
  - 'entity:refreshToken'
  - 'entity:retryWithBackoff'
---
# AuthService refreshToken timeout

The AuthService.refreshToken() call times out after 5 seconds. Fix: call retryWithBackoff() with exponential backoff up to 15 seconds.

## Fix

The AuthService.refreshToken() call times out after 5 seconds. Fix: call retryWithBackoff() with exponential backoff up to 15 seconds.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
