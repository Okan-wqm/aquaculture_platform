# AquaMobil Read-After-Write Visibility

Date: 2026-04-29

## Problem

Several mobile write paths could commit or queue data without invalidating the
tenant-scoped read models used by list/detail screens. This explains the user
symptom where data exists in the database but is not immediately visible in the
frontend or mobile app.

Additional water-quality issue: the mobile water quality form sent a
`measurements` array, but the backend mutation accepts `dynamicParameters`,
`parameters`, and a required `source`. That was a DTO contract mismatch, not a
cache-only issue.

## Root Fix

Created a single awaited invalidation path in
`web/apps/aquamobil/src/utils/offline-sync-invalidation.ts` and routed online
and offline sync success through it.

The map now covers:

- farm stock/tank operations;
- water quality, including AI/read-model refresh;
- warehouse summary and location stock;
- task list/stat counters;
- messaging channels/messages/unread counters.

The water quality form now builds the backend DTO directly:

- `source: 'MANUAL'`;
- `dynamicParameters` keyed by configured parameter code;
- `parameters: {}` for compatibility with the existing static field;
- `idempotencyKey` for offline retry safety.

Network fallback is now restricted to transport failures. GraphQL validation or
business errors stay visible and are not queued forever.

## Verification

- `web/apps/aquamobil/src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts`
- `web/apps/aquamobil/src/hooks/__tests__/useTaskActions.spec.ts`
