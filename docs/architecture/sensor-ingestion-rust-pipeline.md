# Sensor Ingestion Rust Pipeline

`apps/sensor-ingestion` is now the live data-plane path for tenants whose ingest policy is `rust`.

## Flow

1. MQTT message arrives from `sensors/<tenant>/<sensor>/data` or `tenants/<tenant>/devices/<device>/io_data`.
2. Rust topic parser extracts tenant, sensor, and optional device UUIDs without regex.
3. Payload validator uses strict JSON (`deny_unknown_fields`), UUID parsing, finite numeric checks, quality-code bounds, producer timestamp bounds, and topic/payload tenant equality.
4. Sensor lookup resolves authoritative sensor metadata through `sensor.lookup.by-topic`.
5. Device-scoped topics include `deviceId`; sensor-service replies only when the sensor metadata/configuration binds that device.
6. Rust validates channel id against returned metadata.
7. Batches are grouped by tenant.
8. PostgreSQL transaction creates `pg_temp.sensor_metrics_stage`, binary COPYs the batch, upserts into `<tenant>.sensor_metrics`, enqueues one `SensorMetricIngested` row per reading in `sensor.event_outbox`, then commits.
9. Rust outbox dispatcher publishes `events.<tenant>.SensorMetricIngested` with `Nats-Msg-Id`.
10. Sensor-service consumes the event for validation/enrichment and typed event publishing; it does not persist the metric again.

## Fail-Closed Rules

- MQTT configured without Postgres is a startup error. Logging sink is allowed only for non-live smoke mode.
- Missing or mismatched sensor metadata drops the reading when lookup is configured.
- Device-scoped MQTT topics fail closed when the sensor has no matching configured device binding.
- V1 payloads cannot carry `rawValue`; `rawValue` is accepted only with `payloadVersion: 2`.
- Outbox publish failures keep rows in `sensor.event_outbox` for retry.

## Persistence Boundary

The staging table is transaction-local `pg_temp`, not a shared tenant table. This avoids shared staging collisions and avoids requiring a separate tenant-schema table sync. The durable tables are:

- `<tenant>.sensor_metrics`
- `sensor.event_outbox`

## Sensor-Service Role

Sensor-service is now control-plane plus event bridge for this path:

- owns sensor/channel/device metadata lookup;
- validates/enriches sidecar events;
- emits typed events for downstream consumers;
- keeps legacy MQTT code available only for tenants still routed to `node`.
