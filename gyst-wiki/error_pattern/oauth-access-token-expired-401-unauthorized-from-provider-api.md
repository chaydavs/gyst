---
type: error_pattern
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.059Z'
sources: 3
affects:
  - src/auth/oauth.ts
  - src/auth/tokenStore.ts
  - src/middleware/auth.ts
tags:
  - oauth
  - token-expiry
  - '401'
  - authentication
  - google
---
# OAuth access token expired: 401 Unauthorized from provider API

OAuth tokens expire after 1 hour (Google) or provider-specific TTL. Symptoms: API calls suddenly return 401 after working for a while. Fix: implement automatic token refresh — store the refresh_token alongside access_token in the session, and wrap all provider API calls in a retry-with-refresh function. Use the `oauth2client.refreshAccessToken()` pattern. Always check `expiry_date` before making calls. Never cache tokens in memory across serverless invocations — use a persistent store (Redis or DB).

## Fix

OAuth tokens expire after 1 hour (Google) or provider-specific TTL. Symptoms: API calls suddenly return 401 after working for a while. Fix: implement automatic token refresh — store the refresh_token alongside access_token in the session, and wrap all provider API calls in a retry-with-refresh function. Use the `oauth2client.refreshAccessToken()` pattern. Always check `expiry_date` before making calls. Never cache tokens in memory across serverless invocations — use a persistent store (Redis or DB).

## Evidence

**Affected files:**
- `src/auth/oauth.ts`
- `src/auth/tokenStore.ts`
- `src/middleware/auth.ts`

**Sources:** 3
