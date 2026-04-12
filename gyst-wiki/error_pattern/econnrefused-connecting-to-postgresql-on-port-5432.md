---
type: error_pattern
confidence: 0.9
last_confirmed: '2026-04-12T16:34:45.057Z'
sources: 6
affects:
  - src/store/database.ts
  - docker-compose.yml
  - .env.example
tags:
  - postgresql
  - connection
  - ECONNREFUSED
  - docker
  - ci
---
# ECONNREFUSED connecting to PostgreSQL on port 5432

Database connection refused during local development or CI. Most common causes: (1) Postgres service not started — run `brew services start postgresql@16` or `docker compose up -d db`; (2) wrong DATABASE_URL port in .env — verify it matches the docker-compose port mapping; (3) firewall blocking localhost connections. In CI, ensure the postgres service block in your workflow YAML has `health-checks` and a depends-on before the test step.

## Fix

Database connection refused during local development or CI. Most common causes: (1) Postgres service not started — run `brew services start postgresql@16` or `docker compose up -d db`; (2) wrong DATABASE_URL port in .env — verify it matches the docker-compose port mapping; (3) firewall blocking localhost connections. In CI, ensure the postgres service block in your workflow YAML has `health-checks` and a depends-on before the test step.

## Evidence

**Affected files:**
- `src/store/database.ts`
- `docker-compose.yml`
- `.env.example`

**Sources:** 6
