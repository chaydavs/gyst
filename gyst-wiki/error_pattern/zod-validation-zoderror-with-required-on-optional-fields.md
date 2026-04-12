---
type: error_pattern
confidence: 0.79
last_confirmed: '2026-04-12T16:34:45.069Z'
sources: 2
affects:
  - src/compiler/extract.ts
  - src/mcp/server.ts
tags:
  - zod
  - validation
  - typescript
  - optional
  - schema
---
# Zod validation: ZodError with 'Required' on optional fields

ZodError fires 'Required' on fields marked `.optional()` when the field is present but explicitly set to `undefined` in a JSON parse context. JSON.parse strips keys with undefined values, so the field is absent, not undefined. Fix: use `.optional().or(z.undefined())` or switch to `.nullish()` if the API might send null. For API inputs, prefer explicit null checks. If using Zod v4+, the behavior of `.optional()` changed — test all schemas after upgrading.

## Fix

ZodError fires 'Required' on fields marked `.optional()` when the field is present but explicitly set to `undefined` in a JSON parse context. JSON.parse strips keys with undefined values, so the field is absent, not undefined. Fix: use `.optional().or(z.undefined())` or switch to `.nullish()` if the API might send null. For API inputs, prefer explicit null checks. If using Zod v4+, the behavior of `.optional()` changed — test all schemas after upgrading.

## Evidence

**Affected files:**
- `src/compiler/extract.ts`
- `src/mcp/server.ts`

**Sources:** 2
