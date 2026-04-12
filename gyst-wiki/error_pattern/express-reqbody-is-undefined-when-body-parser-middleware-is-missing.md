---
type: error_pattern
confidence: 0.84
last_confirmed: '2026-04-12T16:34:45.087Z'
sources: 3
affects:
  - src/api/index.ts
  - src/api/middleware.ts
tags:
  - express
  - body-parser
  - middleware
  - api
  - error
---
# Express: req.body is undefined when body-parser middleware is missing

Express 4.x does not parse request bodies by default. If `express.json()` middleware is not registered, req.body is `undefined` and destructuring it throws. Common symptom: `const { userId } = req.body` throws 'Cannot destructure property userId of undefined'. Fix: add `app.use(express.json())` before route handlers. For file uploads use `multer`. For URL-encoded forms use `express.urlencoded({ extended: true })`. Order matters: body parsing middleware must come before route handlers. For Bun's built-in HTTP server, parse the body with `await req.json()` or `await req.text()`.

## Fix

Express 4.x does not parse request bodies by default. If `express.json()` middleware is not registered, req.body is `undefined` and destructuring it throws. Common symptom: `const { userId } = req.body` throws 'Cannot destructure property userId of undefined'. Fix: add `app.use(express.json())` before route handlers. For file uploads use `multer`. For URL-encoded forms use `express.urlencoded({ extended: true })`. Order matters: body parsing middleware must come before route handlers. For Bun's built-in HTTP server, parse the body with `await req.json()` or `await req.text()`.

## Evidence

**Affected files:**
- `src/api/index.ts`
- `src/api/middleware.ts`

**Sources:** 3
