---
type: error_pattern
confidence: 0.92
last_confirmed: '2026-04-12T16:34:45.059Z'
sources: 5
affects:
  - src/webhooks/stripe.ts
  - src/api/webhooks.ts
tags:
  - stripe
  - webhook
  - signature
  - express
  - billing
---
# Stripe webhook signature verification failed: No signatures found

Webhook signature verification fails when: (1) the raw request body has been consumed/parsed before reaching the signature check — you must pass the raw Buffer, NOT the parsed JSON; (2) the wrong Stripe webhook secret is used (test vs live, or wrong endpoint secret from the Stripe dashboard); (3) a proxy or API gateway re-encodes the body. Fix: in Express, use `express.raw({ type: 'application/json' })` on the webhook route, NOT `express.json()`. Retrieve the raw body via `req.body` (Buffer). Always use `stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET)`.

## Fix

Webhook signature verification fails when: (1) the raw request body has been consumed/parsed before reaching the signature check — you must pass the raw Buffer, NOT the parsed JSON; (2) the wrong Stripe webhook secret is used (test vs live, or wrong endpoint secret from the Stripe dashboard); (3) a proxy or API gateway re-encodes the body. Fix: in Express, use `express.raw({ type: 'application/json' })` on the webhook route, NOT `express.json()`. Retrieve the raw body via `req.body` (Buffer). Always use `stripe.webhooks.constructEvent(payload, sig, process.env.STRIPE_WEBHOOK_SECRET)`.

## Evidence

**Affected files:**
- `src/webhooks/stripe.ts`
- `src/api/webhooks.ts`

**Sources:** 5
