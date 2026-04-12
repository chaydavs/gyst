---
type: learning
confidence: 0.91
last_confirmed: '2026-04-12T16:34:45.081Z'
sources: 4
affects:
  - src/webhooks/stripe.ts
  - src/api/index.ts
tags:
  - stripe
  - webhook
  - express
  - body-parsing
  - hmac
  - learning
---
# Stripe webhook: always use raw Buffer body, not parsed JSON

Learned the hard way: Stripe's `constructEvent` computes a HMAC over the raw request bytes. If Express has already parsed the body as JSON (via `express.json()`), the byte representation changes (key ordering may shift, whitespace is lost) and the HMAC no longer matches. Solution: register `express.raw({ type: 'application/json' })` specifically on the webhook route BEFORE the global `express.json()` middleware. Test by deliberately introducing a one-character body mutation — the signature check should fail. This same pattern applies to GitHub webhooks.

## Evidence

**Affected files:**
- `src/webhooks/stripe.ts`
- `src/api/index.ts`

**Sources:** 4
