# Farm Data SSOT & Tenant Read Boundary — 2026-06-28

Review cycle backing the Farm Data SSOT remediation (plan: `farm-data-ssot-sequential-sifakis`).
Validated against the codebase with adversarial multi-agent review; the "data
appears/disappears" symptom traces to a fail-open tenant read path, mock data in
production report tabs, and farm-module operating off the GraphQL contract SSOT.

## FARM-HIGH-060 — Tenant DB boundary does not set/assert the RLS GUC or resolved schema

`runInTenantRead` / `runInTenantTransaction` pinned `search_path` transaction-locally
but never set or verified `app.current_tenant` and never read back `current_schema()`.
The RLS GUC is set only on pool checkout (`rls-connection-bootstrap.service.ts`), so a
lost tenant context (unset GUC → RLS denies all rows) or a missing tenant schema
(search_path silently falls back to the `farm` source schema) produced an empty result
indistinguishable from a legitimately-empty table — the platform's "data disappears"
failure mode.

Evidence:
- `libs/backend-common/src/database/tenant-transaction.ts:93`
- `libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:94`
- `apps/farm-service/src/site/handlers/get-site.handler.ts:26`

Fix: the boundary now owns `app.current_tenant` transaction-locally and asserts
`current_schema()` + the GUC against the expected `tenant_<uuid>` before any domain
query runs, throwing a typed `TenantContextError` (`SCHEMA_MISMATCH` / `RLS_MISMATCH`)
instead of returning a silent empty result. See `tenant-transaction.ts` +
`tenant-context-error.ts`.

## FARM-HIGH-061 — get-site / get-department mask lost tenant context as not-found

`GetSiteHandler` and `GetDepartmentHandler` read via raw `@InjectRepository` and
returned `null` with the comment *"This handles connection pool race conditions
where search_path might be reset"* — conflating a lost tenant context with a
legitimate not-found, the literal "data disappears" path.

Evidence:
- `apps/farm-service/src/site/handlers/get-site.handler.ts`
- `apps/farm-service/src/department/handlers/get-department.handler.ts`

Fix: both now read through `runInTenantRead` (which asserts schema + RLS GUC), so
a context failure throws `TenantContextError` and `null` means an honest
not-found. The masking comments are removed.

## FARM-HIGH-062 — list-farms / get-pond / list-sites read outside the tenant boundary

`ListFarmsQueryHandler`, `GetPondQueryHandler`, and `ListSitesHandler` read via
raw `@InjectRepository` (find/findAndCount/createQueryBuilder), relying only on
pool-checkout search_path + RLS — no boundary assertion.

Evidence:
- `apps/farm-service/src/farm/query-handlers/list-farms.handler.ts`
- `apps/farm-service/src/farm/query-handlers/get-pond.handler.ts`
- `apps/farm-service/src/site/handlers/list-sites.handler.ts`

Fix: all three now read through `runInTenantRead` (asserts schema + RLS GUC) via
`queryRunner.manager`. `get-farm` is deliberately deferred — its federation
`__resolveReference` path is tenant-less by design and needs the explicit
source-read API (FARM-* / plan §8.3) rather than the tenant boundary.

## FARM-CRITICAL-060 — onboarding seeders run without a tenant context (NATS handler)

`TenantOnboardingEventHandler.handle()` invoked five per-tenant seeders directly.
The seeders write via `@InjectRepository`, which resolves the tenant schema + RLS
GUC from AsyncLocalStorage — but a NATS event handler has no HTTP request
context, so the seed writes routed to the source `farm` schema (or were
RLS-denied) instead of `tenant_<uuid>`. A freshly-provisioned tenant could end up
with its default data in the wrong schema.

Evidence:
- `apps/farm-service/src/water-quality/event-handlers/tenant-onboarding.event-handler.ts`

Fix: the five-seeder run is wrapped in `withTenantContext(event.tenantId, ...)`
(matching `harvest-completed.listener.ts` / `mortality-recorded.listener.ts`); the
ack/fail publish stays outside the frame (cross-tenant outbox infra). A new test
asserts `getRequestContext().tenantId` is set during seeding.

## FARM-HIGH-063 — list-available-tanks hand-rolled QueryRunner + SET search_path

`ListAvailableTanksHandler` opened its own `createQueryRunner()` and issued
`SET search_path TO "tenant_…", farm, public` (session-level, no RLS GUC, no
assertion, manual RESET) to run two raw SELECTs.

Evidence:
- `apps/farm-service/src/batch/query-handlers/list-available-tanks.handler.ts`

Fix: replaced with `runInTenantRead` — the raw SELECTs now run on a boundary
connection whose search_path + RLS GUC are pinned and asserted; the hand-rolled
SET/RESET and the duplicated schema-name derivation are removed.

## FARM-HIGH-064 — TanksPage blanks the whole page on a background-refetch error

`TanksPage` returned an error-only view on `if (error)` with no `&& !data` guard,
so a failed background refetch blanked the entire table even though TanStack
Query still held the previously-loaded tanks in cache — the "data appears then
disappears" UX bug.

Evidence:
- `web/modules/farm-module/src/pages/tanks/TanksPage.tsx`

Fix: a shared `isBlockingError(error, hasData)` helper (`utils/list-view-state.ts`)
now gates the blocking error view to the initial-load-failure case only; on a
refetch error with cached data, the table keeps rendering and a non-blocking
amber banner with Retry is shown. Helper unit-tested.

## FARM-HIGH-065 — invalidateQueries used the full (epoch'd) key builder → silent misses

`createTenantQueryKey` appends `{__sessionEpoch}` LAST. Used as an
`invalidateQueries` filter, that trailing object lands at the array index a full
query key holds its filter/args, so a query stored under
`['tenant',t,'systems','list',filter,{epoch}]` is NOT matched by
`['tenant',t,'systems','list',{epoch}]` (index 4 mismatch). The list shows stale
data until `staleTime` elapses — the "data doesn't refresh after a mutation" bug.

Evidence:
- `web/shared-ui/src/utils/tenant-query-keys.ts`
- `web/modules/farm-module/src/hooks/useSystems.ts`

Fix: new `createTenantInvalidationKey(tenantId, ...segments)` returns a clean
epoch-less domain prefix that left-prefix-matches every stored key under those
segments. Proven with a real `QueryClient` match test (buggy full-key filter
misses; the prefix matches). `useSystems` invalidations migrated. FOLLOW-UP:
sweep the remaining farm-module invalidate/remove sites + add an invariant
banning the full-key builder in invalidation calls.

## FARM-HIGH-066 — realtime invalidation used the full (epoch'd) key builder

`useFarmRealtimeStream.ts:238` wrapped each INVALIDATION_MAP prefix with
`createTenantQueryKey` (epoch trailing), so socket-driven invalidations missed
any args-bearing list query across session-epoch generations — realtime updates
silently failed to refresh args-keyed lists.

Evidence:
- `web/modules/farm-module/src/hooks/useFarmRealtimeStream.ts:238`

Fix: switched to `createTenantInvalidationKey` (epoch-less prefix).

## FARM-HIGH-067 — tenant erasure event handler ran without a tenant context

`TenantErasureRequestedHandler.handle()` called `TenantErasureService` directly.
As a NATS handler it has no request context, so the destructive erasure could run
against the source schema / a missing tenant context.

Evidence:
- `apps/farm-service/src/compliance/tenant-erasure-requested.handler.ts`

Fix: wrapped the delegate in `withTenantContext(event.tenantId, ...)` (matches
the harvest/onboarding listeners); fails closed on an invalid tenantId.

## FARM-MEDIUM-075 — AquaMobil leaves unscoped localStorage keys across logout

`clearAllUserData()` wiped biometric PII + IndexedDB caches but left two UNSCOPED
localStorage keys behind: `aquamobil-wq-mru` (water-quality MRU equipment list)
and `aquamobil_last_sync_at` (last-sync timestamp). On a shared field device the
next user saw the prior user's MRU + sync time.

Evidence:
- `web/apps/aquamobil/src/hooks/useAuth.tsx:167`
- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:81`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx:34`

Fix: `clearAllUserData()` now `localStorage.removeItem`s both keys (try/catch for
private-mode safety), mirroring the biometric wipe.

## FARM-MEDIUM-076 — batch DataLoaders batched by batchId with no explicit tenant filter

`batch-feed-assignment`, `batch-location`, and `batch-document` DataLoaders
batched `batchId IN (...)` with NO `tenantId` in the WHERE, relying solely on the
request-scoped search_path. A misrouted pooled connection could batch-leak
another tenant's rows.

Evidence:
- `apps/farm-service/src/batch/dataloaders/batch-feed-assignment.dataloader.ts`
- `apps/farm-service/src/batch/dataloaders/batch-location.dataloader.ts`
- `apps/farm-service/src/batch/dataloaders/batch-document.dataloader.ts`

Fix: each batch fn now reads `getRequestContext().tenantId` (the request's
AsyncLocalStorage frame propagates through the loader's batch tick) and adds it to
the WHERE — defense-in-depth on top of search_path. (`batch-species` /
`tank-batch` loaders already filtered explicitly.)

## FARM-HIGH-068 — batch read handlers (get-batch, list-batches) read outside the boundary

`GetBatchHandler` and `ListBatchesHandler` read via raw `@InjectRepository`
query builders (no boundary). `ListBatchesHandler` also injected an unused
`TankBatch` repository (the tank/site/department filters use raw SQL subqueries).

Evidence:
- `apps/farm-service/src/batch/query-handlers/get-batch.handler.ts`
- `apps/farm-service/src/batch/query-handlers/list-batches.handler.ts`

Fix: both migrated to `runInTenantRead` via `queryRunner.manager.createQueryBuilder`;
dropped the dead `TankBatch` injection. Specs added.

## FARM-HIGH-069 — remaining batch read handlers read outside the boundary

`GenerateBatchNumberHandler` and `GetBatchHistoryHandler` read via raw
`@InjectRepository`. `GetBatchHistoryHandler` also injected an unused
`MortalityRecord` repository.

Evidence:
- `apps/farm-service/src/batch/query-handlers/generate-batch-number.handler.ts`
- `apps/farm-service/src/batch/query-handlers/get-batch-history.handler.ts`

Fix: both migrated to `runInTenantRead` via `queryRunner.manager`; dropped the
dead `MortalityRecord` injection. Specs added. (`get-batch-performance` is
deferred — it delegates to cost/FCR services that do their own DB access and need
boundary-awareness first.)

## FARM-HIGH-070 — feeding read handlers (get-feeding-records, get-feed-inventory) outside the boundary

Both read via raw `@InjectRepository` query builders (no boundary).

Evidence:
- `apps/farm-service/src/feeding/query-handlers/get-feeding-records.handler.ts`
- `apps/farm-service/src/feeding/query-handlers/get-feed-inventory.handler.ts`

Fix: both migrated to `runInTenantRead` via `queryRunner.manager.createQueryBuilder`
(dropped the unused `LessThanOrEqual` import in get-feed-inventory). Specs added.
Remaining feeding reads (`get-daily-feeding-plan`, `get-feeding-summary`) tracked.

## FARM-HIGH-071 — growth + feeding-summary read handlers outside the boundary

`GetGrowthMeasurementsHandler`, `GetLatestMeasurementHandler`, and
`GetFeedingSummaryHandler` read via raw `@InjectRepository` (query builder + two
`findOne`s + a multi-entity aggregation), relying only on pool-checkout
search_path + RLS — no boundary assertion.

Evidence:
- `apps/farm-service/src/growth/query-handlers/get-growth-measurements.handler.ts`
- `apps/farm-service/src/growth/query-handlers/get-latest-measurement.handler.ts`
- `apps/farm-service/src/feeding/query-handlers/get-feeding-summary.handler.ts`

Fix: all three now read through `runInTenantRead` via `queryRunner.manager`
(query builder / `findOne` / `find`); the `NotFoundException` paths are kept (the
boundary asserts context, so `null` / not-found is honest). Dropped the unused
`Between` / `MoreThanOrEqual` / `LessThanOrEqual` imports in `get-feeding-summary`
(the date filters use raw SQL). Specs added for all three. Remaining reads
(`get-daily-feeding-plan`, `get-growth-analysis`, water-quality configs) tracked
under plan Task #9.

## Related (tracked separately in the plan)

- FARM-CRITICAL-* umbrella: 139/169 farm handlers read via raw `@InjectRepository`
  (0 use `runInTenantRead`); reads must migrate onto the asserting boundary and the
  error-masking `null`/`[]` blocks (`get-site`, `get-department`, `system.resolver`,
  `farm.resolver`) removed.
- Production mock data in routed report tabs (`reports/tabs/*Tab.tsx`).
- farm-module off the GraphQL codegen SSOT (raw `graphqlClient.request<...>` generics).
