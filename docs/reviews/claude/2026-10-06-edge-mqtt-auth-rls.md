# Edge MQTT auth and provisioning blind under FORCE RLS (2026-10-06)

Found while designing per-sensor MQTT identity on top of the edge-device auth
path. Same defect class as SENSOR-HIGH-137 (the MQTT ingestion listener).

## SENSOR-CRITICAL-143 — every edge gateway is refused at MQTT CONNECT

The broker's HTTP auth hook (`/mqtt/auth`, `/mqtt/acl`) and the public
provisioning endpoints resolve an edge device with no request tenant:

- `DeviceDirectoryService.lookupTenantId` read `sensor.edge_device_directory`
  through the pool. The table carries the FORCED tenant-isolation policy and
  the pool is deny-by-default outside a request, so the lookup matched
  nothing. On prod, as `sensor_service`: 0 rows visible of 1.
- The fallback then read `"tenant_x".edge_devices` (and a UNION across all
  tenant schemas) the same way: 0 rows without `app.current_tenant`, 1 with it.
- `MqttAuthService.verifyDeviceCredentials` therefore never found the device
  and the CONNECT was denied; the own-device ACL check failed the same way.
- `ProvisioningService` wrote through `dataSource.transaction` +
  `SET LOCAL search_path` with no tenant GUC: auto-provisioning's INSERT fails
  the policy's WITH CHECK, activation's and recovery's UPDATE match zero rows.

The one prod edge device has never reported (`last_seen_at` is NULL).

Fix: `DeviceDirectoryService.findDevice` is the single public-identifier
resolver for both services. The directory is read through `runInSourceRead`
(the sanctioned, transaction-local cross-tenant read of a source-schema table)
and the device row inside the owning tenant's `runInTenantRead`; a directory
miss is a denial (see the security-review section below). The three
provisioning writes run in `runInTenantTransaction`. Two duplicated row mappers
and UNION scans are gone.

`edge-mqtt-auth.rls.postgres.spec.ts` (non-owner role, FORCE RLS on the tenant
schemas and on `sensor`) authenticates a gateway, rejects a wrong password and
grants only its own tenant's topic. Against the previous code all three auth
cases fail.

## SENSOR-HIGH-144 — a device can take over another session's client ID

Raised by the edge-expert review of ADR-047. `/mqtt/auth` receives the client
ID but never compared it with the username. Mosquitto evicts the existing
session on a duplicate client ID, so any authenticated device could connect as
`aqua-sensor-service-main` and knock the ingestion listener (persistent
session) off the broker, or evict another gateway. Unreachable while
SENSOR-CRITICAL-143 refused every device; reachable the moment it is fixed.

Fix: a device principal must connect under its username or exactly
`<username>-<deviceCode>`, the ID the edge gateway derives
(`sens-api-gateway/src/mqtt.rs`); a missing, foreign or sibling client ID is
refused. Service accounts are unchanged. `mqtt-acl.mosquitto.spec.ts` (real
broker + go-auth) passes locally with `MQTT_ACL_E2E=1`; no workflow sets that
flag, so the spec does not run in CI.

## Independent security review → fixes (2026-10-08)

An independent review of PR #1805 found the items below. Each was fixed in the
same PR unless noted.

1. HIGH — a PENDING_APPROVAL device could connect and publish (only
   revoked/decommissioned were refused; the ACL never looked at state).
   `mayHoldBrokerSession` (edge-device.entity.ts) is now the one allow-list:
   ACTIVE, OFFLINE, MAINTENANCE, ERROR. It is a `Record` over the enum, so a
   new state does not compile until it is classified. CONNECT and every ACL
   check apply it and re-read the device; the 5-minute positive tenant cache
   and its erasure hook are gone. Device-reported heartbeats and the stale
   sweep can no longer move a device into an admitted state. Self-register
   still returns `mqtt_password` while pending: the agent's
   `SelfRegisterResponse.mqtt_password` is required and there is no later
   credential fetch, so the predicate is what keeps the device off the broker.
2. HIGH — verified unsafe. go-auth 3.0.0 keys its auth cache on
   `auth-<username>-<password>` (cache/cache.go; same format string in the
   shipped `go-auth.so`), not the client ID. With production's 5 s cache the
   real-broker spec admits known credentials under `aqua-sensor-service-main`
   right after a grant; with the cache off it refuses. `auth_cache_seconds 0`
   does not disable it, so production runs `auth_opt_cache false`. The test
   harness now boots from `mosquitto-production.conf` itself.
3. MEDIUM — PBKDF2 runs through async `crypto.pbkdf2`. The tenant scan on a
   directory miss is gone: every device-creating path (`registerDevice`,
   `createProvisionedDevice`, self-register) goes through
   `DeviceDirectoryService.saveNewDevice` (device + route, one transaction),
   and migration 1822000000000 backfills routes for older devices.
4. MEDIUM — partly fixed. A sent `X-Mosquitto-Auth` is compared with
   `timingSafeEqual` on equal-length buffers. An absent header is still
   admitted: go-auth has no custom-header option at all, so requiring it would
   refuse every CONNECT in production. Tracked as SENSOR-MEDIUM-174.
5. LOW — refused CONNECTs log a structured debug record with a sha256
   fingerprint of the username, never the raw value.
6. LOW — the `<username>-*` prefix rule is now an exact
   `<username>-<deviceCode>` match.
7. Tests — the real-Postgres spec covers same `device_code` in two tenants, a
   directory row naming the wrong tenant, pending (then approved) and revoked
   devices, a directory miss and the backfill. Each refusal is paired with an
   acceptance on the same fixture, so deny-everything fails it.

Heartbeats and the stale-offline sweep were blind the same way (pooled reads
of `"tenant_x".edge_devices`, search_path without the tenant GUC). Fixed in
the same PR:

- `updateHeartbeat` reads and writes the device inside the topic tenant's
  `runInTenantTransaction`; a tenant-less legacy topic resolves the tenant
  through the directory. A device UUID under another tenant's topic matches
  nothing.
- `markStaleDevicesOffline` runs on `forEachVerifiedTenantSchema` (active,
  ledger-proven tenants) with `bindTenantRlsContext`, and reads the affected
  count from a structured result (a bare `query()` never reported one).
- `getStats` reads inside `runInTenantRead`.

The real-Postgres spec proves heartbeat and sweep now see rows, only in their
own tenant; against the previous service both cases fail.

Still open, tracked:

- SENSOR-HIGH-175 — tenant provisioning-key lookup is FORCE-RLS blind
  (`tenant-key.service.ts`, pooled UNION), so self-register still fails.
- SENSOR-MEDIUM-176 — a suspended/archived tenant's devices authenticate on a
  directory hit.
- SENSOR-MEDIUM-177 — two concurrent activations with one token can both
  succeed (no `token_used_at IS NULL` claim).
- SENSOR-MEDIUM-178 — with caches off each PUBLISH costs two transactions:
  7.9 ms serial, ~200 ACL checks/s per instance on the test harness.
- SENSOR-LOW-179 — lookup by `device_code` is ambiguous across tenants
  (fails closed).
- `bulkAddIoConfigs` uses `manager.getRepository(DeviceIoConfig)` inside an
  unscoped `dataSource.transaction`; already tracked as ORPHAN-DIC-001.

## SENSOR-MEDIUM-174 — the broker cannot carry the auth endpoints' secret

mosquitto-go-auth (3.0.0, the latest release) sets only Content-Type and
User-Agent on its HTTP calls; `auth_opt_http_headers` is not an option it
parses. The `/mqtt/*` endpoints therefore rest on network isolation (nginx
refuses `/mqtt/` from outside), while the production bootstrap gate accepts
`MQTT_AUTH_SECRET` as if it protected them. Fix options: a dedicated
internal-only listener for `/mqtt/*`, or a broker transport that carries a
credential (mTLS); then an absent header becomes a denial.
