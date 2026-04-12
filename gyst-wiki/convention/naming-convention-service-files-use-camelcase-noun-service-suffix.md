---
type: convention
confidence: 0.92
last_confirmed: '2026-04-12T16:34:45.070Z'
sources: 6
affects:
  - src/services/userService.ts
  - src/services/billingService.ts
tags:
  - naming
  - convention
  - services
  - files
  - typescript
---
# Naming convention: service files use camelCase noun + 'Service' suffix

All service layer files follow the pattern `{domain}Service.ts` in camelCase: userService.ts, billingService.ts, notificationService.ts. The class/object exported also uses the same name. Repository files use `{domain}Repository.ts`. Do NOT use 'Manager', 'Handler', or 'Controller' for the service layer — those names are reserved for HTTP controllers. Domain names are singular: user (not users), order (not orders).

## Evidence

**Affected files:**
- `src/services/userService.ts`
- `src/services/billingService.ts`

**Sources:** 6
