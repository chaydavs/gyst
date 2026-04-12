---
type: learning
confidence: 0.82
last_confirmed: '2026-04-12T16:34:45.085Z'
sources: 2
affects:
  - src/utils/events.ts
  - src/types/events.ts
tags:
  - typescript
  - template-literal-types
  - events
  - type-safety
  - learning
---
# TypeScript: template literal types for type-safe event names

Using template literal types for event names (type EventName = DomainAction) prevents typos in event emission/subscription. Discovered while debugging a silent failure where an event was emitted as user:created but the handler listened to users:create. With template literal types, TypeScript catches these at compile time. Apply this pattern to: Redis pub/sub channels, EventEmitter events, WebSocket message types, analytics event names. Cost: slightly more verbose but eliminates an entire class of bugs.

## Evidence

**Affected files:**
- `src/utils/events.ts`
- `src/types/events.ts`

**Sources:** 2
