# ADR-047: Per-sensor MQTT identity for directly publishing sensors

- **Status:** Proposed — direction chosen by the operator; revised after the edge-expert
  review (2026-10-06); sensor-expert sign-off pending
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

1. **Principal.** On registration, and on demand through a rotate mutation, the service
   issues the username `sensor-<sensorId>.<credentialId>` (lowercase) and a random
   32-byte secret, returned once in the mutation result (no-store) and never stored or
   logged in clear. The MQTT client ID MUST equal the username; `/mqtt/auth` refuses
   any other client ID, so no principal can take over another session (the listener's
   fixed client ID included). The tenant `sensors` row keeps `mqtt_username` and the
   secret's HMAC-SHA-256 under a server-side pepper: a slow KDF adds nothing for a
   256-bit random secret and would run synchronously on the ingestion event loop. A
   cross-tenant `sensor.sensor_mqtt_directory (mqtt_username PK, sensor_id UNIQUE,
tenant_id)` with FORCE RLS maps the username to its tenant, written in the same
   transaction as the sensor row and read through `runInSourceRead` (the pattern
   SENSOR-CRITICAL-143 fixed for edge devices). Authentication routes by username
   prefix; a directory miss is a denial — there is no tenant scan. Sensor principals
   require the HTTP auth mode.
2. **Topic.** The topic is `tenants/{tenantId}/sensors/{sensorId}/data`, assigned by
   the server and not editable for a platform-broker sensor.
3. **ACL.** Only the owning principal may publish (`acc=2`) to its topic. Sensor
   principals are evaluated before any development-topic allowance and get nothing
   else: no subscribe, no read, no `test/` or `debug/`, no other sensor or tenant. Every
   service account is denied `acc=2` on `tenants/+/sensors/+/data`; `sensor_service`
   holds read and subscribe (`acc` 1 / 4) on that filter only, derived from the
   listener's filter list as for SENSOR-HIGH-118. Only then does the topic identify
   its publisher.
4. **Ingestion.** Both ingestion paths — the Node listener and the sensor-ingestion
   sidecar (ADR-025) — route `tenants/+/sensors/+/data` before any edge-device
   handler, take the tenant and sensor ids from the topic, and load the sensor inside
   `runInTenantRead`; no scan, no topic cache. Messages with `retain=1` and payloads
   that fail the schema are dropped and counted; a per-sensor rate bucket runs before
   any database work.
5. **Lifecycle.** A platform-broker sensor skips the connection test. The first
   ingested message moves `registration_status` from DRAFT to ACTIVE inside
   `runInTenantTransaction` — never out of SUSPENDED — and stamps `last_seen_at`; the
   Devices page derives online/offline from `last_seen_at`.
6. **Credentials lifecycle.** Rotation issues a new username and deletes the old
   directory row in the same transaction. go-auth checks the password only at CONNECT
   and caches ACL decisions for 5 s, so the old session's next PUBLISH is denied within
   that window. Suspending or deleting the sensor removes the directory row.
7. **Legacy `sensors/#`.** Sensors registered before this ADR keep their topics until
   they are moved to an issued identity; a tracked finding with an owner and deadline
   lists them (the simulator first). New registrations cannot use the legacy namespace.
   When the list is empty, `sensors/#` leaves the subscription set and `sensor_service`
   loses its publish grant there. Consumers to update with it:
   `sensorprotocols/mqtt-protocol.md` (it tells sensors to retain readings, use a
   retained Will and a `sensors/{location}` tree), the sidecar's topic parser and
   filters, `mqtt-acl.mosquitto.spec.ts`, and the Node-RED simulator flows.
8. **Device contract.** Host from `MQTT_PUBLIC_BROKER_HOST`, port 8883, TLS 1.2 or
   later with public CA roots (nginx terminates TLS); MQTT 3.1.1 or 5, QoS 1,
   `retain=false`, no Will, keepalive at most 300 s. The broker sets a
   `max_packet_size`, and the per-sensor rate cap is a stated number. Unlike ADR-015's
   service identities, a sensor authenticates with a secret, not a client certificate
   — a deliberate deviation for constrained devices that cannot hold a key pair.

Out of scope here: sensors on a customer-operated (external) broker. That mode needs
its own subscription manager and gets its own ADR. Sensors behind an edge gateway are
unchanged: the gateway is the principal.

## Consequences

- A leaked sensor password can only forge that one sensor's readings; it cannot read
  anything or reach another tenant. Today the equivalent leak is `sensor_service`.
- Topic capture across tenants becomes impossible: the topic carries the tenant id and
  the ACL binds it to its one publisher, service accounts included.
- The client-ID rule also closes a takeover open today: any authenticated principal can
  connect as `aqua-sensor-service-main` and evict the ingestion listener.
- The wizard's MQTT path changes: the broker host, port, topic and credentials are
  shown by the platform after submit, not typed by the user.
- One more cross-tenant directory table in `sensor`, registered in
  `MODULE_SCHEMAS[].infrastructureTables`.
- Migrating the existing simulator needs one credential issue plus a Node-RED flow edit.
