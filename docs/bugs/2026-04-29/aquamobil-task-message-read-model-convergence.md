# AquaMobil Task and Messaging Read Model Convergence

Date: 2026-04-29

## Problem

Task mutations invalidated `myTasks`, but `useMyTasks` owned local component
state and only refetched on mount/manual calls. Messaging optimistic sends wrote
to a bare cache key that did not match the tenant-prefixed key used by
`useMessages`.

Both issues can make successful writes invisible until remount or a full
refetch.

## Root Fix

`useMyTasks` now uses React Query with the tenant query-key factory, preserving
the encrypted IndexedDB fallback. `useSendMessage` now writes/cancels/updates
the same tenant-prefixed message key that `useMessages` reads and awaits the
central synced-operation invalidation map after online success.

## Verification

- `web/apps/aquamobil/src/hooks/__tests__/useTaskActions.spec.ts`
- `web/apps/aquamobil/src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts`
- `npx tsc -p web/apps/aquamobil/tsconfig.json --noEmit`
