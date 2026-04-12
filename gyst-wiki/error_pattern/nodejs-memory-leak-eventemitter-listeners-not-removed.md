---
type: error_pattern
confidence: 0.8
last_confirmed: '2026-04-12T16:34:45.061Z'
sources: 2
affects:
  - src/mcp/server.ts
  - src/utils/events.ts
tags:
  - memory-leak
  - eventemitter
  - node
  - listeners
  - performance
---
# Node.js memory leak: EventEmitter listeners not removed

MaxListenersExceededWarning followed by gradual RSS growth. Happens when event listeners are added inside request handlers or component mount effects without corresponding removal. Fix: always store the listener reference and call removeListener/off in cleanup. In Bun HTTP handlers, use AbortSignal.addEventListener with { once: true }. Profile with `process.memoryUsage()` snapshots every 60 seconds to confirm leak. Common culprit: `process.on('message', handler)` inside a loop.

## Fix

MaxListenersExceededWarning followed by gradual RSS growth. Happens when event listeners are added inside request handlers or component mount effects without corresponding removal. Fix: always store the listener reference and call removeListener/off in cleanup. In Bun HTTP handlers, use AbortSignal.addEventListener with { once: true }. Profile with `process.memoryUsage()` snapshots every 60 seconds to confirm leak. Common culprit: `process.on('message', handler)` inside a loop.

## Evidence

**Affected files:**
- `src/mcp/server.ts`
- `src/utils/events.ts`

**Sources:** 2
