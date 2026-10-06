# ADR-047: Per-sensor MQTT identity for directly publishing sensors

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** okan (operator decision, 2026-10-06: "sensör başına kimlik"),
  claude (sensor-service); edge-expert review required for the broker contract
- **Relates to:** ADR-014 / ADR-015 (identity is the authenticated principal, never a
  self-asserted field), ADR-011 (schema ownership), ADR-025 (Rust ingestion sidecar),
  SENSOR-HIGH-117/118/119/137, SENSOR-CRITICAL-143,
  `docs/reviews/claude/2026-10-06-sensor-device-registration-inputs.md`

## Context

A sensor that speaks MQTT itself (no edge gateway in between) has no identity on the
platform broker today.

- The broker's HTTP auth backend admits three service accounts and edge devices
  (`edge_devices.mqtt_client_id`). The username and password typed into the add-device
  wizard are stored in `protocol_configuration` and never reach the broker.
- Only `sensor_service` may publish under `sensors/`, the namespace the ingestion
  listener reads for plain sensors. That account also reads and writes every tenant's
  `tenants/*/(sensors|devices|alerts|commands)/` topics. Handing it to a field device
  hands out cross-tenant command publish; the running water-quality simulator does
  exactly that.
- The topic is free text and resolved by scanning tenants, first match wins. Another
  tenant registering the same or a wildcard topic captures the stream.
- The wizard's connection test dials the configured broker through the outbound SSRF
  guard, which rejects the platform broker's RFC-1918 address. The test fails, the
  sensor is saved as DRAFT, and nothing moves it out of DRAFT.

## Decision

**A directly publishing sensor gets its own broker principal, a server-assigned topic,
and an ACL that admits that one topic only. Data arrival, not a cloud-initiated
connection test, activates it.**

1. **Principal.** On registration (and on demand through a rotate mutation) the
   service issues a username `sensor-<sensorId>` and a random 32-byte password,
   returned once in the mutation result and never stored or logged in clear. The
   tenant `sensors` row keeps `mqtt_username` and `mqtt_password_hash` (the existing
   `$7$` PBKDF2-SHA512, 600 000 iterations). A cross-tenant
   `sensor.sensor_mqtt_directory (mqtt_username PK, sensor_id, tenant_id)` maps the
   username to its tenant, maintained in the same transaction as the sensor row and read
   through `runInSourceRead` (the pattern SENSOR-CRITICAL-143 fixed for edge devices).
2. **Topic.** The topic is `tenants/{tenantId}/sensors/{sensorId}/data`, assigned by
   the server and not editable for a platform-broker sensor.
3. **ACL.** A sensor principal may publish (`acc=2`) to its assigned topic and nothing
   else: no subscribe, no read, no other tenant, no other sensor. `sensor_service`
   subscribes `tenants/+/sensors/+/data`; the grant is derived from the listener's
   filter list, as for SENSOR-HIGH-118.
4. **Ingestion.** For that namespace the listener takes the tenant and sensor ids from
   the topic, which the broker ACL has already bound to the authenticated principal,
   and loads the sensor inside `runInTenantRead`. No cross-tenant scan, no topic cache.
5. **Lifecycle.** A platform-broker sensor skips the connection test. The first
   ingested message moves it from DRAFT to ACTIVE and stamps `last_seen_at`; the
   Devices page derives online/offline from `last_seen_at`.
6. **Credentials lifecycle.** Rotation replaces the hash, so the old password stops
   working at the broker's next auth check. Deleting or decommissioning the sensor
   removes the directory row and the hash.
7. **Legacy `sensors/#`.** Sensors registered before this ADR keep their topics until
   they are moved to an issued identity; a tracked finding with an owner and deadline
   lists them (the simulator first). New registrations cannot use the legacy namespace.
   When the list is empty, `sensors/#` leaves the subscription set and `sensor_service`
   loses its publish grant there.

Out of scope here: sensors on a customer-operated (external) broker. That mode needs
its own subscription manager and gets its own ADR. Sensors behind an edge gateway are
unchanged: the gateway is the principal.

## Consequences

- A leaked sensor password can only forge that one sensor's readings; it cannot read
  anything or reach another tenant. Today the equivalent leak is `sensor_service`.
- Topic capture across tenants becomes impossible: the topic carries the tenant id and
  the ACL binds it to the principal.
- The wizard's MQTT path changes: the broker host, port, topic and credentials are
  shown by the platform after submit, not typed by the user.
- One more cross-tenant directory table in `sensor`, registered in
  `MODULE_SCHEMAS[].infrastructureTables`.
- Migrating the existing simulator needs one credential issue plus a Node-RED flow edit.
