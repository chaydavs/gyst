---
type: convention
confidence: 0.88
last_confirmed: '2026-04-12T16:34:45.070Z'
sources: 4
affects:
  - src/store/database.ts
  - src/store/search.ts
  - .eslintrc.json
tags:
  - imports
  - convention
  - eslint
  - typescript
  - organization
---
# Import ordering: external, internal, relative — each group separated by blank line

TypeScript imports follow three groups with a blank line between each: (1) Node built-ins prefixed with 'node:' (e.g., `import { readFile } from 'node:fs'`); (2) External npm packages (e.g., `import { z } from 'zod'`); (3) Internal absolute paths or relative imports (e.g., `import { logger } from '../utils/logger.js'`). Within each group, sort alphabetically. Never mix groups. Configure ESLint import/order rule to enforce this automatically. All imports must use .js extensions for ESM compatibility.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `src/store/search.ts`
- `.eslintrc.json`

**Sources:** 4
