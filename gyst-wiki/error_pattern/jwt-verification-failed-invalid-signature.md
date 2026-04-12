---
type: error_pattern
confidence: 0.91
last_confirmed: '2026-04-12T16:34:45.066Z'
sources: 5
affects:
  - src/auth/jwt.ts
  - src/middleware/auth.ts
tags:
  - jwt
  - authentication
  - signature
  - security
  - multi-service
---
# JWT verification failed: invalid signature

JWT signature verification fails when: (1) the signing secret differs between the issuer and verifier (common in multi-service setups where each service has its own JWT_SECRET env var with different values); (2) token was signed with RS256 but verified with HS256; (3) the token was tampered with. Fix: centralise JWT_SECRET in a shared secrets manager (AWS Secrets Manager, 1Password). Use asymmetric keys (RS256/ES256) for multi-service verification — only the auth service needs the private key; all other services use the public key. Add the algorithm explicitly to both sign and verify calls.

## Fix

JWT signature verification fails when: (1) the signing secret differs between the issuer and verifier (common in multi-service setups where each service has its own JWT_SECRET env var with different values); (2) token was signed with RS256 but verified with HS256; (3) the token was tampered with. Fix: centralise JWT_SECRET in a shared secrets manager (AWS Secrets Manager, 1Password). Use asymmetric keys (RS256/ES256) for multi-service verification — only the auth service needs the private key; all other services use the public key. Add the algorithm explicitly to both sign and verify calls.

## Evidence

**Affected files:**
- `src/auth/jwt.ts`
- `src/middleware/auth.ts`

**Sources:** 5
