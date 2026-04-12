---
type: error_pattern
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.063Z'
sources: 3
affects:
  - src/billing/stripe.ts
  - scripts/migrate-subscriptions.ts
tags:
  - stripe
  - rate-limit
  - '429'
  - backoff
  - billing
---
# Stripe rate limit error: 429 Too Many Requests

Stripe returns 429 when the API is called more than 100 times per second in test mode (higher in live). Occurs during data migration scripts or bulk operations. Fix: implement exponential backoff with jitter — start at 1s, double with ±20% jitter, max 32s, max 5 retries. The Stripe Node SDK has built-in retry support: `new Stripe(key, { maxNetworkRetries: 3 })`. For bulk operations, add a `p-limit` concurrency limiter: `const limit = pLimit(10)` to cap parallel calls. Never loop over Stripe calls without rate limiting.

## Fix

Stripe returns 429 when the API is called more than 100 times per second in test mode (higher in live). Occurs during data migration scripts or bulk operations. Fix: implement exponential backoff with jitter — start at 1s, double with ±20% jitter, max 32s, max 5 retries. The Stripe Node SDK has built-in retry support: `new Stripe(key, { maxNetworkRetries: 3 })`. For bulk operations, add a `p-limit` concurrency limiter: `const limit = pLimit(10)` to cap parallel calls. Never loop over Stripe calls without rate limiting.

## Evidence

**Affected files:**
- `src/billing/stripe.ts`
- `scripts/migrate-subscriptions.ts`

**Sources:** 3
