# sensor_metrics under FORCE RLS — writers and rollup owner unbound (2026-10-06)

Found by the red-team round on the sensor-history / water-chemistry plan
(multi-tenant and performance lenses), confirmed in code, and reproduced on
the pinned `timescale/timescaledb-ha:pg16` image in
`apps/sensor-service/src/ingestion/__tests__/sensor-metric-writer.rls.postgres.spec.ts`.

Context:

- `applyTenantRlsToSchema` arms ENABLE + FORCE RLS on every tenant table with
  a uuid tenant column, skipping only columnstore/compressed hypertables.
- 1815 creates each tenant's `sensor_metrics` hypertable uncompressed, so every
  freshly provisioned tenant gets FORCE RLS on it.
- `tenant_isolation_policy` admits a row only when `app.current_tenant` names
  its tenant (or `app.bypass_rls` is on).
- The single production tenant escaped SENSOR-HIGH-145/146 only because legacy
  compression made the helper skip its `sensor_metrics`. Its `sensors` and
  `sensor_data_channels` do carry FORCE RLS, which is what SENSOR-HIGH-148
  describes.

## SENSOR-HIGH-145 — the sensor_metrics writers bind no tenant

`SensorMetricWriterService.insertTenantRows` (buffered flush and
`writeImmediate`) opened `dataSource.transaction` and inserted into the
validated tenant schema. The schema was right, but no tenant was bound.
`SensorIngestionService.ingestReading` / `ingestBatch` called `writeManaged`
inside unbound transactions too, and the Rust sidecar's `write_tenant_batch`
COPY + upsert set nothing. Under FORCE RLS each INSERT failed with
`new row violates row-level security policy for table "sensor_metrics"`: a new
tenant could not store a single reading. The MQTT path was not affected, because
it already writes inside `runInTenantTransaction` (SENSOR-HIGH-137).

Fix:

- The writer's own paths run each tenant batch through `runInTenantTransaction`.
- `writeManaged` never re-binds a caller's transaction. It verifies, with the
  new fail-closed `assertTenantRlsBound`, that the caller bound exactly the
  rows' tenant, and throws `TenantContextError` before sending a row otherwise.
  `bindTenantRlsContext`, `assertTenantRlsBound` and
  `assertTenantTransactionContext` share one rule for "bound to this tenant".
- The ingestion service's write transactions bind per reading, and per
  (chunk, tenant) for batches.
- The sidecar binds with `set_config` and refuses the batch unless both values
  read back. A source test pins the binding ahead of the first write. The
  sidecar is not deployed, and no test runs it against a live database.
- The GUC names live in `tenant_context::{RLS_TENANT_GUC, RLS_BYPASS_GUC}`. A
  fixture shared with `tests/invariants/tenant-schema-golden.spec.ts` pins them
  to the TypeScript constants.

## SENSOR-HIGH-146 — the rollup owner cannot read sensor_metrics under RLS

The db-migrate authority grants `sensor_aggregate_owner` SELECT on
`sensor_metrics`. TimescaleDB refreshes rollups as that role with no tenant
setting, and real-time rollup reads also run with its rights, so FORCE RLS hides
every source row from it. Reproduced: a refresh without a policy materialized 0
of 1 rows and reported `already up-to-date`. The watermark advances, so the loss
is silent and permanent. With a SELECT policy for the owner the same refresh
materialized the row.

Fix: when `applyTenantRlsToSchema` arms RLS on a tenant table, it also
reconciles `continuous_aggregate_owner_read` (`FOR SELECT TO <every role owning
a continuous aggregate over the table> USING (true)`).

- The owners come from the TimescaleDB catalog, so nothing sensor-specific is
  hard-coded.
- One `DO` statement leaves a correct policy untouched (no lock on the ingest
  hypertable on every deploy) and replaces a wrong one atomically.
- A table no aggregate reads any more loses the policy.
- Compressed tables are skipped as before, so the production tenant's deploy
  issues no new DDL.
- The authoritative boot gate in `ContinuousAggregateService` refuses a tenant
  whose `sensor_metrics` has row security but no such policy.

Scope of `USING (true)`: one shared, passwordless role owns every tenant's
rollups. It is used only by the TimescaleDB scheduler and by the views' own
execution. Through the policy it sees every row of the tenant schema's table,
whatever `app.current_tenant` says. The schema is therefore the tenant boundary
for rollups, as it already was for materialized rollup data. No application
role gains a row it could not see before. A row ever filed into the wrong
tenant's schema would be rolled up there. The writer derives the schema from
each row's own tenant, which prevents that for new rows.

TimescaleDB refuses to create a continuous aggregate on a hypertable that
already has row security, including a hierarchical one on top of a rollup. The
provisioner already creates rollups before arming RLS. Any later rollup change
on an RLS-armed table needs its own procedure.

## SENSOR-HIGH-148 — non-MQTT ingestion reads outside the tenant boundary

Found by the pre-commit audit of the fix above. sensor-service binds tenants
per operation (`runInTenantRead` / `runInTenantTransaction`). Its pool sets only
`search_path`. These paths still use bare repositories:

- **GraphQL ingest:** the `CalibrationService` channel load (which swallows
  errors to `[]`), the batch prefetch, the channel auto-provision INSERT, the
  `last_seen_at` updates and the parent-routing child lookup.
- **Edge/IO path:** `DataIngestionService`.
- **NATS sidecar consumer:** `SensorMetaCacheService`.

Under FORCE RLS they see zero rows. Ingestion through them fails or stores
uncalibrated values. On the production tenant this is already true for every
route except MQTT.

Fix (the follow-up PR, stacked on the writer fix):

- Every read and write on these paths runs in the owning tenant's
  `runInTenantRead` / `runInTenantTransaction`, through
  `tenantManagerRepo`. The services no longer inject bare repositories.
- The tenant is the request's (GraphQL), the sensor row's (edge/IO) or the
  event's (NATS).
- `DataIngestionService`'s boot scan walks the active tenants through
  `listActiveTenantSchemaIdentities` instead of one cross-tenant query.
- Each channel/sensor cache entry carries its tenant, and a hit for another
  tenant is a miss.
- `CalibrationService` no longer swallows a failed read into `[]`: an ingest
  that cannot load its calibration fails instead of storing raw values as
  calibrated.
- A NATS event whose sensor belongs to another tenant now resolves to "unknown
  sensor" (acknowledged, counted) instead of "tenant mismatch" (dead-lettered):
  the other tenant's row is invisible to a read bound to the event's tenant.
  It can never be written under that tenant; the mismatch branch stays as an
  assertion over the read.
- Proof: `sensor-ingestion-paths.rls.postgres.spec.ts` drives the three paths
  as a non-owner role under FORCE RLS. Mutating one read back to an unbound
  query turns it red.
- The five sensor RLS Postgres specs now share one stage
  (`src/__tests__/support/sensor-rls-postgres.harness.ts`), pinned by
  `tests/invariants/sensor-rls-postgres-harness-ssot.spec.ts`. The unit-level
  tenant-session fake lives once in `@platform/testing`.

## SENSOR-LOW-147 — the source schema is a scattered literal

The tenant boundaries take sensor-service's source schema as an argument. It is
passed as `'sensor'` literals at about two dozen call sites and as four
file-local `SENSOR_SCHEMA` constants. This change adds one
`SENSOR_SOURCE_SCHEMA`, derived from the MODULE_SCHEMAS sensor entry, and
adopts it in the metric writer, the ingestion service and db-migrate (whose own
copy is removed). The remaining call sites, and an invariant against the
literal, follow under this finding.
