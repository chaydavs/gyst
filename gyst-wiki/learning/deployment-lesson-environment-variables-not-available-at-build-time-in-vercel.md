---
type: learning
confidence: 0.87
last_confirmed: '2026-04-12T16:34:45.086Z'
sources: 3
affects:
  - src/config.ts
  - vercel.json
tags:
  - vercel
  - deployment
  - env-vars
  - build
  - learning
  - nextjs
---
# Deployment lesson: environment variables not available at build time in Vercel

Build-time code that reads process.env fails in Vercel deployments if the env vars aren't marked as 'Available during build' in the Vercel dashboard. Learned when our config validation module (which runs at import time) threw during build. Fix: (1) mark all required env vars as available during build in Vercel settings; (2) or defer config validation to request-time (lazy initialization pattern). Prefer option 1 for fail-fast behavior. Also: NEXT_PUBLIC_ prefix is required for browser-accessible vars — they're inlined at build time.

## Evidence

**Affected files:**
- `src/config.ts`
- `vercel.json`

**Sources:** 3
