---
type: error_pattern
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.068Z'
sources: 4
affects:
  - src/api/profile.ts
  - src/middleware/auth.ts
  - src/services/userService.ts
tags:
  - null-error
  - authentication
  - middleware
  - user-context
  - api
---
# getUserProfile throwing null error on missing user context

getUserProfile() throws 'Cannot read properties of null (reading userId)' when called from a route that doesn't require authentication but still calls the function. The auth middleware doesn't populate req.user for public routes, so req.user is null. Fix: always guard with `if (!req.user) { return res.status(401).json({ error: 'Unauthorized' }); }` before accessing req.user properties. Alternatively, split the function into getProfileOrNull() and getProfileRequired() — the latter throws if user is absent, making the intent explicit at the call site.

## Fix

getUserProfile() throws 'Cannot read properties of null (reading userId)' when called from a route that doesn't require authentication but still calls the function. The auth middleware doesn't populate req.user for public routes, so req.user is null. Fix: always guard with `if (!req.user) { return res.status(401).json({ error: 'Unauthorized' }); }` before accessing req.user properties. Alternatively, split the function into getProfileOrNull() and getProfileRequired() — the latter throws if user is absent, making the intent explicit at the call site.

## Evidence

**Affected files:**
- `src/api/profile.ts`
- `src/middleware/auth.ts`
- `src/services/userService.ts`

**Sources:** 4
