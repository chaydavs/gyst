---
type: convention
confidence: 0.95
last_confirmed: '2026-04-12T16:34:45.069Z'
sources: 8
affects:
  - src/utils/response.ts
  - src/api/middleware.ts
tags:
  - api
  - error-handling
  - convention
  - response-format
---
# API error response format: always use the standard error envelope

All API endpoints must return errors in the standard envelope: `{ success: false, error: 'Human-readable message', code: 'MACHINE_READABLE_CODE' }`. Never return raw error messages from exceptions directly — they may leak internal paths, stack traces, or sensitive data. Use the `createErrorResponse(code, message)` helper in src/utils/response.ts. For validation errors, include a `details` field with per-field errors. HTTP status codes: 400 for validation, 401 for auth, 403 for authorization, 404 for not found, 409 for conflicts, 422 for unprocessable, 500 for internal.

## Evidence

**Affected files:**
- `src/utils/response.ts`
- `src/api/middleware.ts`

**Sources:** 8
