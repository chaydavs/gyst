---
type: error_pattern
confidence: 0.5
last_confirmed: '2026-04-14T08:52:57.268Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - timeout
---
# AuthService timeout on token refresh

The AuthService times out after 5 seconds when the refresh-token endpoint is slow. Increase the HTTP client timeout to 15 seconds and add a retry with exponential backoff.

## Fix

The AuthService times out after 5 seconds when the refresh-token endpoint is slow. Increase the HTTP client timeout to 15 seconds and add a retry with exponential backoff.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
