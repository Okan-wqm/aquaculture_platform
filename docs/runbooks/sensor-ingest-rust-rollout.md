# Runbook: Rust Sensor Ingest Rollout

## Purpose

Move tenant sensor ingestion from the NestJS MQTT data plane to `apps/sensor-ingestion` without data loss. Rust is the write path for tenants whose dynamic ingest policy is `rust`; sensor-service remains the metadata/control-plane owner and typed event bridge.

## Pre-Flight

- `sensor-ingestion` has `[mqtt]`, `[postgres]`, and `[nats]` configured.
- Startup must fail if `[mqtt]` exists without `[postgres]`.
- `sensor.event_outbox` has `claimed_at` and `claimed_by`.
- Existing tenant schemas have `<tenant>.sensor_metrics`; no tenant staging table is required.
- Sensor metadata contains device bindings for device-scoped MQTT topics. Accepted keys include `deviceId`, `edgeDeviceId`, `gatewayDeviceId`, `deviceUuid`, and snake_case equivalents under `protocolConfiguration`, `metadata`, or `configuration`.
- JetStream duplicate window is at least 10 minutes.

## Tenant Flip

1. Publish or update the authoritative ingest policy so the target tenant maps to `rust`.
2. Confirm `sensor_ingestion_policy_change_applied_total` increments.
3. Confirm MQTT drain logs show accepted readings for the tenant.
4. Confirm `<tenant>.sensor_metrics` row count advances.
5. Confirm `sensor.event_outbox` pending count drains.
6. Confirm downstream typed sensor events continue through sensor-service.

## Rollback

1. Publish policy mapping the tenant back to `node`.
2. Confirm Rust sidecar stops accepting that tenant and logs policy-routed skips.
3. Confirm legacy sensor-service MQTT path advances `<tenant>.sensor_metrics`.
4. Leave `sensor.event_outbox` rows in place; dispatcher retry/lease semantics finish or retry outstanding publishes.

## Queries

```sql
SELECT MAX(time) AS last_metric, COUNT(*) AS rows_5m
FROM tenant_<tenant_hex>.sensor_metrics
WHERE time > now() - interval '5 minutes';
```

```sql
SELECT COUNT(*) AS pending
FROM sensor.event_outbox
WHERE dispatched_at IS NULL
  AND dispatch_attempts < 10;
```

```sql
SELECT id, tenant_id, event_type, claimed_at, claimed_by, dispatch_attempts, last_error
FROM sensor.event_outbox
WHERE dispatched_at IS NULL
ORDER BY created_at
LIMIT 20;
```

## Failure Signals

- Startup error: missing Postgres config with MQTT configured.
- `sensor metadata lookup returned no authoritative result`.
- `channel id not present in resolved sensor metadata`.
- `sensor.lookup.by-topic device mismatch`.
- Pending outbox grows while `claimed_at` keeps renewing.
- Rows reach `dispatch_attempts >= 10`.

## Operator Decision

Promote a tenant only when metric writes, outbox drain, and downstream typed events are all healthy for the observation window. Roll back on any fail-closed drop that is not explained by an intentionally unregistered sensor or device.
