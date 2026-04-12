---
type: convention
confidence: 0.89
last_confirmed: '2026-04-12T16:34:45.088Z'
sources: 4
affects:
  - src/api/middleware.ts
  - src/api/auth.ts
tags:
  - rate-limiting
  - security
  - convention
  - express
  - api
---
# Rate limiting: apply per-route limits in addition to global limits

The global rate limit (e.g., 100 req/min per IP) protects against DDoS but is too loose for sensitive endpoints. Apply tighter per-route limits: auth endpoints (login, register, forgot-password) get 5 req/15min; API key generation gets 3 req/hour; password reset gets 3 req/hour. Use `express-rate-limit` with separate store per endpoint. For distributed deployments, use a shared Redis store (`rate-limit-redis`) — in-memory store is per-process and doesn't work behind a load balancer. Always return `Retry-After` header with 429 responses.

## Evidence

**Affected files:**
- `src/api/middleware.ts`
- `src/api/auth.ts`

**Sources:** 4
