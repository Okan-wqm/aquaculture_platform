# Aquamobil Offline Sync Cache Invalidation

Date: 2026-04-29

## Problem
Farm operations queued offline could sync successfully to the backend, while Aquamobil continued showing stale tank, feeding, stock, water-quality, and AI summary data. This matches the observed class of issues where the database contains the updated tenant data but the frontend does not immediately show it.

## Root Cause
`useOfflineQueue.syncNow` invalidated only leave-request cache keys after a successful sync. Farm mutations such as feeding, mortality, transfer, harvest, water-quality, and stock operations share the same offline write path but did not invalidate their tenant-scoped React Query read models after backend confirmation.

## Enterprise Fix
The offline queue now has a central operation-to-read-model invalidation map in `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts`. After sync, only operations removed from the pending queue are treated as backend-confirmed, and their tenant-scoped query keys are invalidated from `useOfflineQueue`.

## Why The Code Was Added
The offline queue is the convergence point between offline writes and online read models. Keeping invalidation there avoids page-specific patches and ensures DB-committed farm changes become visible across list, card, detail, daily operations, stock summary, water-quality, and AI surfaces for the active tenant.

## Why The Test Was Added
`web/apps/aquamobil/src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts` protects the invalidation contract for the high-risk farm operation set and verifies shared keys are deduplicated. The helper is intentionally a pure utility so the contract can be tested without pulling IndexedDB or React runtime dependencies into the unit test.

## Verification
Passed on 2026-04-29:

```bash
npx vitest run src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts --config vitest.config.ts
```

`npm run typecheck` is currently blocked by pre-existing Aquamobil typecheck drift recorded separately in `docs/bugs/2026-04-29/aquamobil-typecheck-dependency-drift.md`.

## Status
Implemented and targeted-test verified on 2026-04-29.
