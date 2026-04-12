---
type: convention
confidence: 0.91
last_confirmed: '2026-04-12T16:34:45.072Z'
sources: 5
affects:
  - .github/pull_request_template.md
  - scripts/check-secrets.sh
tags:
  - code-review
  - convention
  - security
  - ci
  - quality
---
# Code review checklist: security and correctness gates before merge

PRs require sign-off on: (1) no hardcoded secrets — run `git secrets --scan`; (2) all inputs validated at system boundaries using Zod; (3) error messages don't expose internal state; (4) new API endpoints have rate limiting via express-rate-limit; (5) SQL queries use parameterized inputs only; (6) test coverage stays above 80%; (7) no console.log statements; (8) TypeScript strict mode passes with no 'any' escapes. Automated checks run in CI; manual review focuses on business logic and architecture.

## Evidence

**Affected files:**
- `.github/pull_request_template.md`
- `scripts/check-secrets.sh`

**Sources:** 5
