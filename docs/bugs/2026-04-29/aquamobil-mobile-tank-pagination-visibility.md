# Aquamobil Mobile Tank Pagination Visibility

Date: 2026-04-29

## Problem
Mobile app users can have tanks present in the tenant schema/database but not visible in Aquamobil home, detail, and field-operation screens.

## Root Cause
Aquamobil queried `tanks` without a filter. Farm-service `TankFilterInput` defaults to `limit: 20`, so mobile fetched only the first page. Tenants with more than 20 tanks could have valid database rows that never reached the mobile UI. This affects old and new tenants alike and is independent of offline sync invalidation.

## Enterprise Fix
`useTanks` now fetches tenant tanks page-by-page using the backend maximum page size of 100 until the returned item count reaches `total`. There is no total tank cap in the mobile client; 100 is only the per-request page size allowed by the backend DTO.

## Why The Code Was Added
Tank data is the root read model for mobile home stats, tank cards, tank detail, feeding, mortality, cull, transfer, harvest, and water-quality flows. If this read model is truncated, downstream buttons and edits appear broken even though tenant data exists in the database.

## Why The Test Was Added
`web/apps/aquamobil/src/hooks/__tests__/useTanks-pagination.spec.ts` proves the mobile client requests the next page when `total` exceeds the first page and fails closed if the backend reports more rows but returns an empty page.

## Verification
Passed on 2026-04-29:

```bash
npm run typecheck
npx vitest run src/hooks/__tests__/useTanks-pagination.spec.ts src/hooks/__tests__/useOfflineQueue-invalidation.spec.ts --config vitest.config.ts
```

## Status
Implemented and verified on 2026-04-29.
