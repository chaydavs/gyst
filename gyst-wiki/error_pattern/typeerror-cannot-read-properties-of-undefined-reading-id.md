---
type: error_pattern
confidence: 0.85
last_confirmed: '2026-04-12T16:34:45.055Z'
sources: 4
affects:
  - src/api/users.ts
  - src/store/userRepository.ts
tags:
  - typescript
  - runtime-error
  - null-safety
  - async
---
# TypeError: Cannot read properties of undefined (reading 'id')

Occurs when accessing a property on an object that hasn't been loaded yet, typically after a failed DB query returns undefined instead of null. Fix: always null-check before property access, or use optional chaining (user?.id). Root cause is often a missing WHERE clause match or a race between async operations.

## Fix

Occurs when accessing a property on an object that hasn't been loaded yet, typically after a failed DB query returns undefined instead of null. Fix: always null-check before property access, or use optional chaining (user?.id). Root cause is often a missing WHERE clause match or a race between async operations.

## Evidence

**Affected files:**
- `src/api/users.ts`
- `src/store/userRepository.ts`

**Sources:** 4
