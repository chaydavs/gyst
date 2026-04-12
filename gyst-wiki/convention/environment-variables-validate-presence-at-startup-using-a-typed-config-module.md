---
type: convention
confidence: 0.93
last_confirmed: '2026-04-12T16:34:45.074Z'
sources: 6
affects:
  - src/config.ts
  - .env.example
tags:
  - env-vars
  - convention
  - config
  - zod
  - startup
---
# Environment variables: validate presence at startup using a typed config module

Never access process.env directly in business logic. Instead, define a validated config object in src/config.ts using Zod: `const config = ConfigSchema.parse(process.env)`. This validates all required env vars at startup and fails fast with a clear error listing which vars are missing. Export a typed `config` object that the rest of the codebase imports. Provide a .env.example with all required keys. Document each variable with a comment explaining its purpose and expected format.

## Evidence

**Affected files:**
- `src/config.ts`
- `.env.example`

**Sources:** 6
