---
type: learning
confidence: 0.5
last_confirmed: '2026-04-14T08:53:27.354Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - retry
  - 'entity:refreshToken'
  - 'entity:jitterBackoff'
---
# AuthService retry policy with jitter

When refreshToken() fails transiently, apply jitterBackoff() starting at 100ms. Never exceed 3 retries to avoid token storms.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
