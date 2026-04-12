---
type: decision
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.076Z'
sources: 4
affects:
  - src/auth/jwt.ts
  - docs/decisions/jwt-vs-sessions.md
tags:
  - jwt
  - sessions
  - authentication
  - decision
  - security
  - mcp
---
# Why we use JWT over session cookies for API authentication

Decision made 2024-Q2: JWTs chosen over server-side sessions because: (1) the API is consumed by both browser clients and AI coding agents (MCP tools) — stateless auth works for both without session affinity; (2) microservice architecture means auth tokens need to be verifiable across services without a shared session store; (3) short-lived tokens (15 min) with refresh tokens (7 days) provide acceptable security. Tradeoffs: JWT revocation requires a token blacklist or very short TTLs — we chose 15min access tokens. Cookie-based sessions were evaluated but rejected due to CSRF complexity and cross-origin limitations with the MCP transport.

## Evidence

**Affected files:**
- `src/auth/jwt.ts`
- `docs/decisions/jwt-vs-sessions.md`

**Sources:** 4
