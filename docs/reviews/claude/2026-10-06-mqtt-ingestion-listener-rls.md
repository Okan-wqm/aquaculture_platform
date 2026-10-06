# MQTT ingestion — listener reload blind under FORCE RLS (2026-10-06)

Operator report: `/sensor/readings` shows only water temperature for the
`Codex Su Sıcaklığı Simülatörü` (WT-CODEX-01), although the device publishes
five parameters. Investigated live on the droplet and reproduced on real
Postgres in `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.rls.postgres.spec.ts`.

Live facts (2026-10-06 ~10:30Z):

- The simulator publishes every 10 s on `sensors/codex-test/water-temp-01`:
  `{deviceId, timestamp, temperature, ph, dissolved_oxygen, salinity, ammonia}`.
- The tenant's `sensor_metrics` holds 48 646 `mqtt` rows for all five channels
  between 2026-09-16 15:54Z and 2026-09-19 23:55Z, and nothing after.
- `platform.list_active_tenant_schema_mappings()` returns the tenant for the
  `sensor_service` role; the same role reads the sensor row only with
  `app.current_tenant` set (0 rows without, 1 with).
- The running image (`34db380f9`) has no diff against `origin/main` in
  `apps/sensor-service/src/ingestion/`.

## SENSOR-HIGH-137 — listener reloads the resolved sensor outside the tenant RLS boundary

SENSOR-HIGH-119 moved `SensorTopicCacheService` onto `runInTenantRead`, and its
Postgres spec proved the cache resolves a topic under FORCE RLS. The next hop
was left behind: `MqttListenerService.loadSensorFromCache` reloaded the entity
with `pinTenantSchemaTransactionSearchPath` only. The pool is deny-by-default
outside a request context (`app.current_tenant=''`, `app.bypass_rls='off'`),
so the reload returned `null`, the handler logged `No sensor found for topic`
at debug level and dropped the reading. Every MQTT reading on the platform
broker has been lost since the deploy that armed deny-by-default.

The same handler's debounced `last_seen_at` flush used the unscoped
`Repository<Sensor>`, which matches zero tenant rows under FORCE RLS — sensors
that ingest still show `last_seen_at = NULL`. The `findSensorByTopicLegacy`
fallback (taken when the cache provider is absent) scanned tenant schemas with
`search_path` alone: a second resolver blind in the same way.

Fix: the reload runs in `runInTenantRead` for the owning tenant through the
tenant-scoped repository; a resolved-but-unloadable sensor is an error that
evicts the mapping; the flush groups by tenant inside `runInTenantTransaction`;
the legacy resolver is deleted and the topic cache is a required dependency.

## SENSOR-MEDIUM-136 — scheduled jobs and automation helpers pin search_path without the RLS GUC

The same defect class, outside ingestion. `EdgeDeviceService.markStaleDevicesOffline`
and `AutomationService.checkDeployTimeout` iterate tenant schemas with
`pinTenantSchemaTransactionSearchPath`; `edge_devices`, `automation_programs`
and `deployment_logs` carry FORCE RLS in the tenant schema, so both jobs read
and update zero rows: a dead edge device is never marked offline and a stuck
deploy is never reverted. `AutomationService.withTenantSchema` and
`syncVariables` pin `search_path` with `pinTenantTransactionSearchPath` only and
depend on the caller already holding a tenant context.

Fix: all four go through `runInTenantTransaction` (tenant schema + GUC,
asserted), iterating `listActiveTenantSchemaIdentities`. The stale-device job
also reported 0 devices even when it changed rows (a raw UPDATE answers
`[rows, count]`, which `queryAffectedRows` cannot read); it now requests the
structured result. The invariant
`tests/invariants/tenant-rls-boundary-helpers.spec.ts` rejects any new
`apps/**` import of the two search_path-only helpers.

## MSG-MEDIUM-084 — messaging-service pins search_path without the RLS tenant GUC

`apps/messaging-service/src/ai/services/knowledge-extraction.service.ts` and
`apps/messaging-service/src/compliance/services/retention-policy.service.ts`
import the same two helpers. Whether each callsite already runs inside a tenant
context was not verified in this cycle; the invariant above carries both files
as the only allowed importers, tied to this finding, so the list can only
shrink. Owner claude, deadline 2026-10-20.
