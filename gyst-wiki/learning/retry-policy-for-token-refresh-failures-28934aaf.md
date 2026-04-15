---
type: learning
confidence: 0.5
last_confirmed: '2026-04-15T06:17:31.616Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - retry
  - 'entity:refreshToken'
  - 'entity:jitterBackoff'
---
# Retry policy for token refresh failures

When refreshToken() fails transiently, apply full-jitter backoff via jitterBackoff() starting at 100 ms, doubling each attempt up to 8 seconds. Never retry more than 3 times to avoid token storms on the auth service.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
