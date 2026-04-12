---
type: error_pattern
confidence: 0.85
last_confirmed: '2026-04-12T16:34:45.064Z'
sources: 2
affects:
  - package.json
  - src/cli/index.ts
tags:
  - bun
  - bundler
  - node-fs
  - build-error
  - target
---
# Bun build: Dynamic require of 'node:fs' is not supported

Bun's bundler with `target: 'browser'` strips Node built-ins, causing `Dynamic require of 'node:fs' is not supported` at runtime. Fix: (1) set `target: 'node'` or `target: 'bun'` in build config when the output runs in Node/Bun; (2) use `Bun.file()` instead of `fs.readFileSync` for file reads in Bun-native code; (3) if shipping a library, use conditional exports in package.json to provide browser/node variants. Check all transitive deps for Node-only APIs with `bun build --analyze`.

## Fix

Bun's bundler with `target: 'browser'` strips Node built-ins, causing `Dynamic require of 'node:fs' is not supported` at runtime. Fix: (1) set `target: 'node'` or `target: 'bun'` in build config when the output runs in Node/Bun; (2) use `Bun.file()` instead of `fs.readFileSync` for file reads in Bun-native code; (3) if shipping a library, use conditional exports in package.json to provide browser/node variants. Check all transitive deps for Node-only APIs with `bun build --analyze`.

## Evidence

**Affected files:**
- `package.json`
- `src/cli/index.ts`

**Sources:** 2
