---
type: error_pattern
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.060Z'
sources: 7
affects:
  - tsconfig.json
  - src/utils/logger.ts
tags:
  - typescript
  - esm
  - module-resolution
  - import
  - bundler
---
# TypeScript: Cannot find module '../../src/utils/logger.js' or its corresponding type declarations

With ESM and moduleResolution: 'bundler', TypeScript requires .js extensions in import paths even when the source file is .ts. Fix: always write `import { foo } from './foo.js'` in .ts files — Bun/Node resolves the .ts file at runtime. Running `tsc --noEmit` will fail if extensions are omitted. Also check that the tsconfig `paths` entries include the .js extension in their mapped values.

## Fix

With ESM and moduleResolution: 'bundler', TypeScript requires .js extensions in import paths even when the source file is .ts. Fix: always write `import { foo } from './foo.js'` in .ts files — Bun/Node resolves the .ts file at runtime. Running `tsc --noEmit` will fail if extensions are omitted. Also check that the tsconfig `paths` entries include the .js extension in their mapped values.

## Evidence

**Affected files:**
- `tsconfig.json`
- `src/utils/logger.ts`

**Sources:** 7
