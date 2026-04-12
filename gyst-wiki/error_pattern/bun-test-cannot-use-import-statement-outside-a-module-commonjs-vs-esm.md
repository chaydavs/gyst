---
type: error_pattern
confidence: 0.82
last_confirmed: '2026-04-12T16:34:45.088Z'
sources: 2
affects:
  - package.json
  - tsconfig.json
tags:
  - bun
  - esm
  - commonjs
  - import
  - error
  - testing
---
# Bun test: Cannot use import statement outside a module (CommonJS vs ESM)

Test files fail with 'Cannot use import statement outside a module' when the package.json does not have `"type": "module"` or when importing a CommonJS-only package that uses `require()`. Fix: (1) ensure `"type": "module"` in package.json; (2) for CJS-only packages, use `createRequire` from 'node:module' to import them; (3) check that tsconfig has `module: ESNext` and `moduleResolution: bundler`. With Bun, most CJS packages are automatically shimmed, but some edge cases exist with packages using dynamic `require()` at module evaluation time.

## Fix

Test files fail with 'Cannot use import statement outside a module' when the package.json does not have `"type": "module"` or when importing a CommonJS-only package that uses `require()`. Fix: (1) ensure `"type": "module"` in package.json; (2) for CJS-only packages, use `createRequire` from 'node:module' to import them; (3) check that tsconfig has `module: ESNext` and `moduleResolution: bundler`. With Bun, most CJS packages are automatically shimmed, but some edge cases exist with packages using dynamic `require()` at module evaluation time.

## Evidence

**Affected files:**
- `package.json`
- `tsconfig.json`

**Sources:** 2
