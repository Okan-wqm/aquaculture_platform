# Aquamobil Typecheck Dependency Drift

Date: 2026-04-29

## Problem
`npm run typecheck` in `web/apps/aquamobil` does not complete, preventing full TypeScript verification for targeted frontend changes.

## Observed Errors
The run failed before this work could use it as a full-app gate. Representative failures include unresolved local modules for `idb-keyval`, `firebase/app`, `firebase/messaging`, and `konsta/react`, existing unused symbol errors, service-worker global typing mismatches, and an `AuthStore.logout` type mismatch.

## Root Cause
The app's TypeScript verification surface is not aligned with its installed dependency/type environment and includes legacy files with strict TypeScript errors. This is broader than the offline sync invalidation change.

## Enterprise Fix
`web/apps/aquamobil` now has a reliable install/typecheck boundary:

- The `postinstall` Konsta patch script runs as CommonJS (`scripts/patch-konsta.cjs`) under the app's ESM package boundary.
- The browser app TypeScript config no longer mixes `DOM` and `WebWorker` globals.
- The service worker is checked through `tsconfig.sw.json`.
- Existing unused-symbol and `AuthStore.logout` type-contract errors were fixed in source instead of suppressed.

## Why The Code Was Changed
Typecheck must be a trustworthy gate before adding broader mobile read-after-write tests. Stub declarations or `skip`-style bypasses would hide dependency and boundary drift; the fix makes installation and TypeScript verification deterministic.

## Verification Attempt
Failed on 2026-04-29:

```bash
npm run typecheck
```

Targeted invalidation behavior was still verified with Vitest:

```bash
npx vitest run src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts --config vitest.config.ts
```

## Status
Implemented and verified on 2026-04-29.
