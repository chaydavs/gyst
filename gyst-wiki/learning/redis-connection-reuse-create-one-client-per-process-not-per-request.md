---
type: learning
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.081Z'
sources: 3
affects:
  - src/store/redis.ts
  - src/api/middleware.ts
tags:
  - redis
  - connection-pooling
  - serverless
  - performance
  - learning
---
# Redis connection reuse: create one client per process, not per request

Creating a new Redis client per API request causes connection exhaustion and 'ERR max number of clients reached' after ~15 minutes under load. Redis connections are stateful and cheap — create one client at module load time and export it. For serverless (Vercel Edge, Lambda), use the `lazyConnect: false` option and store the client in the module scope so it persists across warm invocations. Use `ioredis` over `redis` package for better TypeScript support and automatic reconnection. Always handle the 'error' event to prevent unhandled rejection crashes.

## Evidence

**Affected files:**
- `src/store/redis.ts`
- `src/api/middleware.ts`

**Sources:** 3
