# Package 27: frontend-module-federation-auth

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [FE-HIGH-004, FE-HIGH-005, FE-HIGH-006, FE-HIGH-007, FE-HIGH-008]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Frontend authentication and Module Federation HIGHs: (1) Module Federation shared dependencies missing strictVersion flag (version mismatch causes runtime errors), (2) logout cleanup incomplete (tokens remain in memory/storage), (3) token lifecycle does not handle visibilitychange (returning to tab uses expired token), (4) AquaMobil offline key not derived from login credentials (weaker offline security), (5) Firebase service worker has no SRI verification.

## Findings

**FE-HIGH-004** (frontend-expert, HIGH)
File: web/shell/vite.config.ts
Module Federation shared config missing strictVersion:true. React, react-dom, and other shared dependencies can load mismatched versions between shell and remote modules, causing hook ordering violations and hydration mismatches.

**FE-HIGH-005** (frontend-expert, HIGH)
File: web/shell/src/auth/AuthProvider.tsx
Logout handler clears cookies and redirects but does not clear in-memory token cache, sessionStorage auth state, or revoke the refresh token server-side. Zombie tokens remain after logout.

**FE-HIGH-006** (frontend-expert, HIGH)
File: web/shell/src/auth/useTokenRefresh.ts
No visibilitychange event listener. User returns to tab after laptop sleep -- stale token used for next request, gets 401, and user is force-logged-out instead of silently refreshing.

**FE-HIGH-007** (frontend-expert, HIGH)
File: web/apps/aquamobil/src/auth/offlineAuth.ts
Offline encryption key is a hardcoded constant, not derived from user credentials via PBKDF2. Offline data on a stolen device is accessible without knowing the user's password.

**FE-HIGH-008** (frontend-expert, HIGH)
File: web/shell/public/firebase-messaging-sw.js
Firebase service worker loaded without Subresource Integrity (SRI). CDN compromise or man-in-middle could inject malicious code into the push notification handler.

## Affected Files
- web/shell/vite.config.ts
- web/shell/src/auth/AuthProvider.tsx
- web/shell/src/auth/useTokenRefresh.ts
- web/apps/aquamobil/src/auth/offlineAuth.ts
- web/shell/public/firebase-messaging-sw.js

## Dependencies
None. All frontend changes.

## Atomic Commit Plan
```
security(frontend): add MF strictVersion, complete logout cleanup, token lifecycle, offline key derivation

Module Federation missing strictVersion causes version mismatch. Logout does
not clear all token state. Token refresh ignores visibilitychange. Offline
key not login-derived. Firebase SW has no SRI.

Add strictVersion:true to all shared MF dependencies. Clear in-memory cache,
sessionStorage, and call token revocation on logout. Add visibilitychange
listener to trigger token refresh on tab focus. Derive offline key from
user credentials via PBKDF2. Add SRI hash to Firebase SW script tag.

Plan: docs/plans/2026-04-09-high-fixes/packages/27-frontend-module-federation-auth.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-HIGH-008
```

## Test Plan
- Unit test: MF shared deps have strictVersion:true
- Unit test: logout clears all auth state (memory, storage, cookies)
- Unit test: visibilitychange triggers token refresh
- Unit test: offline key is PBKDF2-derived from credentials
- Test: Firebase SW has integrity attribute

## Verification Command
`npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/shell/src/auth`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
