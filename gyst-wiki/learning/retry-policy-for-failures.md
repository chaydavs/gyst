---
type: learning
confidence: 0.5
last_confirmed: '2026-04-14T09:01:03.731Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - 'entity:refreshToken'
  - 'entity:jitterBackoff'
---
# Retry policy for failures

When refreshToken() fails, apply jitterBackoff().

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
