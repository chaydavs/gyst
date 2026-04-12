---
type: decision
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.075Z'
sources: 5
affects:
  - package.json
  - docs/decisions/bun-vs-node.md
tags:
  - bun
  - node
  - runtime
  - decision
  - sqlite
  - architecture
---
# Why we chose Bun over Node.js as the runtime

Decision made 2024-Q1: Bun was chosen over Node.js 20 for three reasons: (1) built-in SQLite via `bun:sqlite` eliminates the `better-sqlite3` native addon compile step, which was causing CI failures on different architectures; (2) Bun's native TypeScript execution removes the ts-node/tsx dev dependency and the build step during development; (3) Bun's test runner is fast enough for our test suite without a separate Jest/Vitest setup. Tradeoffs accepted: Bun's `bun:sqlite` API differs from better-sqlite3, so migration to Node would require a DB layer rewrite. Revisit if Bun's Node compatibility regresses.

## Evidence

**Affected files:**
- `package.json`
- `docs/decisions/bun-vs-node.md`

**Sources:** 5
