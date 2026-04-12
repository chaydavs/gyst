---
type: learning
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.082Z'
sources: 4
affects:
  - src/auth/oauth.ts
  - src/auth/pkce.ts
tags:
  - oauth
  - pkce
  - security
  - session
  - learning
---
# OAuth PKCE flow: the code_verifier must be stored per-session, not globally

PKCE (Proof Key for Code Exchange) requires generating a unique code_verifier for each authorization flow initiation. Storing it globally (e.g., in a module-level variable) breaks concurrent auth flows — a second user starting OAuth would overwrite the first user's verifier. Store the code_verifier in the session (encrypted cookie or Redis) keyed by the state parameter. Validate that the state returned by the provider matches the state you sent before exchanging the code. The state parameter also prevents CSRF attacks — never skip it.

## Evidence

**Affected files:**
- `src/auth/oauth.ts`
- `src/auth/pkce.ts`

**Sources:** 4
