---
type: error_pattern
confidence: 0.83
last_confirmed: '2026-04-12T16:34:45.067Z'
sources: 3
affects:
  - src/components/Layout.tsx
  - src/app/layout.tsx
tags:
  - react
  - hydration
  - ssr
  - nextjs
  - css-in-js
---
# React hydration error: Prop className did not match between server and client

Hydration mismatch when a className is generated using Math.random(), Date.now(), or a browser-only value during SSR. The server renders one class name and the client re-renders with a different one, causing React to bail out of hydration. Fix: (1) use stable IDs based on content hash or a deterministic counter; (2) move random/browser-only values to useEffect so they only run client-side; (3) use `suppressHydrationWarning` only as a last resort for truly dynamic content (like timestamps). This is a common issue with CSS-in-JS libraries that generate class names at runtime.

## Fix

Hydration mismatch when a className is generated using Math.random(), Date.now(), or a browser-only value during SSR. The server renders one class name and the client re-renders with a different one, causing React to bail out of hydration. Fix: (1) use stable IDs based on content hash or a deterministic counter; (2) move random/browser-only values to useEffect so they only run client-side; (3) use `suppressHydrationWarning` only as a last resort for truly dynamic content (like timestamps). This is a common issue with CSS-in-JS libraries that generate class names at runtime.

## Evidence

**Affected files:**
- `src/components/Layout.tsx`
- `src/app/layout.tsx`

**Sources:** 3
