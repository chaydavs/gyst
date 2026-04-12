---
type: convention
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.072Z'
sources: 4
affects:
  - src/
tags:
  - file-organization
  - convention
  - structure
  - refactoring
---
# File organization: feature-first directory structure, 200-400 line file limit

Organize files by domain/feature, not by type. Prefer: `src/auth/{jwt.ts,oauth.ts,middleware.ts}` over `src/middleware/auth.ts`. Keep files between 200-400 lines; extract utilities when a file exceeds 600 lines. One primary export per file. Co-locate tests with source in a parallel `tests/` tree matching `src/` structure. Barrel files (index.ts) allowed only at domain boundaries, never in deep subdirectories. Delete dead code immediately rather than commenting it out.

## Evidence

**Affected files:**
- `src/`

**Sources:** 4
