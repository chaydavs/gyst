---
type: error_pattern
confidence: 0.5
last_confirmed: '2026-04-15T02:38:04.933Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - timeout
  - 'entity:refreshToken'
  - 'entity:retryWithBackoff'
---
# Token refresh timeout on slow endpoint

The refreshToken() method times out after 5 seconds when the token endpoint is under load. Fix: retry with exponential backoff via retryWithBackoff(), using a 15-second ceiling and three maximum attempts.

## Fix

The refreshToken() method times out after 5 seconds when the token endpoint is under load. Fix: retry with exponential backoff via retryWithBackoff(), using a 15-second ceiling and three maximum attempts.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
