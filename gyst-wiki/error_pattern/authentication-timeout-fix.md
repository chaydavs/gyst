---
type: error_pattern
confidence: 0.5
last_confirmed: '2026-04-14T08:53:44.385Z'
sources: 1
affects:
  - src/auth/auth-service.ts
tags:
  - auth
  - timeout
---
# Authentication timeout fix

Token refresh times out after 5 seconds due to slow endpoint. Increase HTTP timeout to 15 seconds and add retry logic with exponential backoff.

## Fix

Token refresh times out after 5 seconds due to slow endpoint. Increase HTTP timeout to 15 seconds and add retry logic with exponential backoff.

## Evidence

**Affected files:**
- `src/auth/auth-service.ts`

**Sources:** 1
