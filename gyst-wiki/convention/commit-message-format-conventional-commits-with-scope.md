---
type: convention
confidence: 0.94
last_confirmed: '2026-04-12T16:34:45.071Z'
sources: 6
affects:
  - .commitlintrc.json
  - docs/contributing.md
tags:
  - git
  - commits
  - convention
  - conventional-commits
  - ci
---
# Commit message format: conventional commits with scope

All commits follow Conventional Commits: `<type>(<scope>): <description>`. Types: feat, fix, refactor, docs, test, chore, perf, ci. Scope is the module or domain: store, api, compiler, mcp, auth, billing. Description is lowercase, imperative mood, no period. Body optional for complex changes. Breaking changes: append `!` after type or add `BREAKING CHANGE:` footer. Examples: `feat(store): add FTS5 search`, `fix(auth): handle token expiry on refresh`, `refactor(api): extract error response helper`.

## Evidence

**Affected files:**
- `.commitlintrc.json`
- `docs/contributing.md`

**Sources:** 6
