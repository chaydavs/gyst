---
type: convention
confidence: 0.93
last_confirmed: '2026-04-12T16:34:45.071Z'
sources: 7
affects:
  - src/utils/logger.ts
  - src/store/database.ts
tags:
  - logging
  - convention
  - structured-logging
  - debug
  - observability
---
# Logging standard: use structured logger, never console.log

All log output must go through the structured logger in src/utils/logger.ts. Never use console.log, console.error, or console.warn in production code. Log levels: debug (internal tracing), info (notable events), warn (recoverable issues), error (requires attention). Always include a context object as the second argument: `logger.info('Entry inserted', { id, type })`. Never log sensitive data: passwords, tokens, PII. Log at function entry for info-level operations, only at debug for high-frequency paths.

## Evidence

**Affected files:**
- `src/utils/logger.ts`
- `src/store/database.ts`

**Sources:** 7
