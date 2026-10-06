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
(the sanctioned, transaction-local cross-tenant read of a source-schema table),
the device row inside the owning tenant's `runInTenantRead`, a miss scans the
active tenants one boundary at a time and backfills the directory inside the
device's `runInTenantTransaction`. The three provisioning writes run in
`runInTenantTransaction`. Two duplicated row mappers and UNION scans are gone.

`edge-mqtt-auth.rls.postgres.spec.ts` (non-owner role, FORCE RLS on the tenant
schemas and on `sensor`) authenticates a gateway, rejects a wrong password,
grants only its own tenant's topic and resolves + backfills on a directory
miss. Against the previous code all three auth cases fail.
