# Gyst Knowledge Base Index

> Generated: 2026-04-14T05:27:20.134Z  
> Active entries: 13

## Convention

- Idempotency optional for GET requests *(confidence: 0.50)*
- Idempotency keys required in test and production environments *(confidence: 0.50)*

## Error Pattern

- Stripe webhook signature validation failure *(confidence: 0.66)*
- Stripe API timeout causes checkout failure *(confidence: 0.66)*
- Refund race condition with webhook *(confidence: 0.66)*
- Webhook endpoint must return 2xx within 30 seconds *(confidence: 0.28)*
- Payment idempotency key prevents double charges *(confidence: 0.28)*
- Webhook delivery order not guaranteed *(confidence: 0.28)*
- PaymentIntent requires_action state handling *(confidence: 0.28)*
- Stripe Connect platform fees calculation *(confidence: 0.28)*
- Currency mismatch in payment amounts *(confidence: 0.28)*
- 3D Secure authentication timeout *(confidence: 0.28)*

## Ghost Knowledge

- Never log card numbers or CVV in any environment *(confidence: 1.00)*
