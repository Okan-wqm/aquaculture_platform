# ADR-047: Per-sensor MQTT identity for directly publishing sensors

- **Status:** Accepted — direction chosen by the operator; revised after the edge-expert
  review (2026-10-06) and three sensor-expert rounds (2026-10-08). Implemented 2026-10-30
  (SENSOR-CRITICAL-173, `docs/reviews/claude/2026-10-08-sensor-mqtt-identity.md`; see
  "Implementation notes"). The legacy publishers still on the service account are listed
  and tracked as SENSOR-HIGH-207.
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

1. **Principal.** Only the row that talks to the broker gets one: a standalone sensor or
   the PARENT of a parent/child registration, never a CHILD (children share the
   parent's connection and payload). On registration, and on demand through a rotate
   mutation, the service issues a username and a random 32-byte secret, returned once
   in the mutation result and never stored or logged in clear. The frontend reads the
   rotate result with `fetchPolicy: 'no-cache'` so no client cache keeps it.
   - The username is `s` plus 22 lowercase base32 characters (110 random bits), 23
     characters in all: the client-ID length MQTT 3.1.1 guarantees, so constrained
     firmware can use it. It names no sensor; the directory maps it.
   - Every principal class has one client-ID binding, checked by `/mqtt/auth`:
     a sensor principal's client ID equals its username; an edge gateway's is
     `{username}-{deviceCode}` (`sens-api-gateway/src/mqtt.rs`); a service account
     uses its own reserved IDs (the listener's `aqua-sensor-service-main` among them).
     A reserved ID presented by any other principal is refused, and a CONNECT without a
     client ID is refused (the hook's `clientid` is optional today). So no principal
     can take over another's session.
   - Until the legacy list (§7) is empty, `sensor_service`'s reserved set also holds
     the client IDs its legacy publishers use today (the simulator's
     `nodered-simulator` among them), as recorded in that tracked finding; each leaves
     the set when its publisher moves to an issued identity.
   - go-auth's auth cache must not answer a CONNECT whose client ID differs from the
     one it checked. Unless the pinned go-auth version is shown to key that cache on
     the client ID, the auth cache is off (the ACL cache stays); the edge-auth change
     (#1805) settles this for the current broker and is a prerequisite.
   - The tenant `sensors` row keeps `mqtt_username`, the secret's HMAC-SHA-256 under a
     server-side pepper, and the pepper's key id. This deliberately overrides the
     sensor domain's PBKDF2 rule for credentials: a slow KDF adds nothing for a 256-bit
     random secret and would run on the ingestion event loop. The pepper lives in the
     secrets manager under that key id, so it rotates without reissuing credentials.
   - A cross-tenant `sensor.sensor_mqtt_directory (mqtt_username PK, sensor_id UNIQUE,
tenant_id)` with FORCE RLS maps the username to its tenant. It is written in the
     same transaction as the sensor row and read through `runInSourceRead`, the pattern
     the edge-device fix for SENSOR-CRITICAL-143 introduces (#1805, a prerequisite: on
     main the edge directory is still read with a plain query). A directory miss is a
     denial — there is no tenant scan. Sensor principals require the HTTP auth mode.
   - The directory is tenant data: tenant erasure deletes its rows by `tenant_id`
     (the sensor erasure target walks only the tenant schema today, so it gets an
     explicit hook). `edge_device_directory` has the same gap and is fixed with it.
   - A sensor row says which broker it uses (`broker_mode`: `platform` or
     `external`). Registering an `external` MQTT sensor is refused until that mode's
     ADR exists; the outbound SSRF guard stays as it is, and a `platform` sensor never
     needs it because it skips the test (§5). Wizard-typed broker usernames and
     passwords are refused on the write path for `platform` sensors.
2. **Topic.** The topic is `tenants/{tenantId}/sensors/{sensorId}/data`, assigned by
   the server and not editable for a platform-broker sensor.
3. **ACL.** Only the owning principal may publish (`acc=2`) to its topic. Sensor
   principals are evaluated before any development-topic allowance and get nothing
   else: no subscribe, no read, no `test/` or `debug/`, no other sensor or tenant. Every
   service account is denied any access with the write bit set (`acc & 2`, which
   includes `acc=3`, the grant `backend_service` holds today) on
   `tenants/+/sensors/+/data`; `sensor_service` holds read and subscribe (`acc` 1 / 4)
   on that filter, derived from the listener's filter list as for SENSOR-HIGH-118, and
   `alert_service` keeps its read grant (`acc=1`) on tenant sensor topics. No service
   account gains a write grant there. Only then does the topic identify its publisher.
   - The sensor ACL path keeps no in-process positive cache (the edge path's 5-minute
     `tenantIdCache` must not be copied), so a revocation is bounded by go-auth's own
     cache window alone (§6).
   - `mqtt-acl.mosquitto.spec.ts` becomes a required CI job, run against a broker
     configured with production's go-auth cache settings, since this decision rests on
     that ACL.
4. **Ingestion.** The Node listener routes `tenants/+/sensors/+/data` before any
   edge-device handler, takes the tenant and sensor ids from the topic, and loads the
   sensor inside `runInTenantRead`; no scan, no topic cache. Messages with `retain=1`
   (the `MqttMessageHandler` signature gains the packet flags for this) and payloads
   that fail the schema (§8) are dropped and counted; a per-sensor rate bucket runs
   before any database work. The erased-tenant tombstone drop `handleMessage` applies
   today runs on this route too, first.
   - The sensor-ingestion sidecar (ADR-025) does not take this topic until it can do
     so safely. Its broker identity is an mTLS client certificate on 8883, which the
     production broker does not listen on (one 1883 listener, HTTP auth); its
     `sensor.lookup.by-topic` reply carries no registration status. Taking the topic
     needs: a sidecar broker principal and ACL grant on the production listener, a
     reply that carries the status, and ADR-027's per-tenant backend policy deciding
     which path persists. Promotion (§5) stays in Node either way.
5. **Lifecycle.** A platform-broker sensor skips the connection test and is saved
   DRAFT. Registration enqueues `SensorRegistrationStarted` and
   `SensorRegistered` only; today both registration paths also enqueue
   `SensorRegistrationCompleted` when `connectionTestPassed || skipConnectionTest`,
   which for a platform sensor would announce completion before any data arrived.
   The first ingested message that persists at least one metric (a sensor can exist
   with no channels, SENSOR-HIGH-117) promotes it, inside one `runInTenantTransaction`:
   - the principal's row and its children move to ACTIVE with `isActive = true`;
   - `SensorRegistrationCompleted` is enqueued through the outbox, once, with
     `connectionTestPassed = true` meaning "data arrived over the issued identity";
   - `last_seen_at` is stamped; the Devices page derives online/offline from it.
     Promotion starts from DRAFT or TEST_FAILED (the state a failed wizard test writes
     today; existing TEST_FAILED platform sensors are promotable as they stand). It never
     starts from SUSPENDED.
   - No cloud-initiated test touches a platform sensor's status: `testSensorConnection`
     is refused for it, `updateProtocolConfig` leaves its status as it is (no
     PENDING_TEST), `activateSensor` is refused (only data promotes a platform
     sensor), and `reactivateSensor` takes the rotate → DRAFT path of §6 without the
     test. So PENDING_TEST and TESTING are unreachable, a sensor reaches ACTIVE only
     through promotion, and an ACTIVE sensor stays ACTIVE while data arrives.
6. **Credentials lifecycle.** Rotation issues a new username and deletes the old
   directory row in the same transaction. go-auth checks the password only at CONNECT
   and caches ACL decisions for its configured window (5 s in production), so the old
   session's next PUBLISH is denied within that window. Suspending or deleting the
   sensor removes the directory row. Leaving SUSPENDED never restores the old row:
   reactivation rotates the credential and returns the sensor to DRAFT, and data over
   the new identity promotes it (§5). A credential that was out while suspended stays
   dead.
7. **Legacy namespaces.** Sensors registered before this ADR keep their topics until
   they are moved to an issued identity; a tracked finding with an owner and deadline
   lists them (the simulator first). New registrations cannot use a legacy namespace.
   - The legacy set is everything plain sensors publish or are read on today:
     `sensors/#`, `aquaculture/+/sensors/#` and `+/+/+/temperature-array` on the
     listener; `sensor_service`'s publish grants under `sensor/`, `sensors/` and
     `aquaculture/`; `backend_service`'s under `sensor/`.
   - When the list is empty, these filters leave the subscription set and the publish
     grants are removed. The listener's readiness (`health/health.controller.ts`, ready
     only while subscribed to `sensors/#`) moves to the new filter in the same change,
     or sensor-service would report unready.
   - The repo's simulator publishes three streams: it needs three principals and three
     connections.
   - The migration deletes wizard-typed broker credentials from
     `protocol_configuration` (stored in clear, redacted only on read).
   - Consumers to update with it: `sensorprotocols/mqtt-protocol.md` (it tells sensors
     to retain readings, use a retained Will and a `sensors/{location}` tree), the
     sidecar's topic parser and filters, `mqtt-acl.mosquitto.spec.ts`, and the
     Node-RED simulator flows.
8. **Device contract.** Host from `MQTT_PUBLIC_BROKER_HOST`, port 8883, TLS 1.2 or
   later with public CA roots (nginx terminates TLS); MQTT 3.1.1 or 5, QoS 1,
   `retain=false`, no Will, keepalive at most 300 s, a client ID of up to 23
   characters. The broker sets a `max_packet_size`, and the per-sensor rate cap is a
   stated number.
   - **Payload.** One UTF-8 JSON object per message, the shape the listener reads
     today: each enabled channel's `dataPath` (or, when it has none, its channel key)
     names a value in it (`{"ph": 7.1, "temperature": 18.4}`).
     - Static checks, in a JSON Schema kept with the other trust-boundary schemas in
       `libs/event-contracts/src/schemas/`: a JSON object, within stated size and depth
       limits, and an optional `timestamp` in RFC 3339 with offset. Other keys (the
       simulator's `deviceId`) are allowed and ignored.
     - Per-sensor check at ingestion: a channel value is a JSON number; numeric strings
       are refused for this route (no `parseFloat`). A message that persists no channel
       value is dropped and counted.
     - `timestamp` is trusted only within a stated skew of the receive time; outside
       it, or absent, the receive time is used and the skew is counted.
   - Unlike ADR-015's
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
- The client-ID bindings also close a takeover open today: any authenticated principal
  can connect as `aqua-sensor-service-main` and evict the ingestion listener. Edge
  gateways and service accounts are bound too (§1), not only sensor principals.
- The wizard's MQTT path changes: the broker host, port, topic and credentials are
  shown by the platform after submit, not typed by the user.
- One more cross-tenant directory table in `sensor`, registered in
  `MODULE_SCHEMAS[].infrastructureTables`.
- Migrating the existing simulator needs three credential issues (one per stream) plus
  a Node-RED flow edit.
- The sidecar keeps reading edge-gateway traffic only, until the conditions in §4 hold.

## Implementation notes

Recorded as each part lands (SENSOR-CRITICAL-173).

### Principal, directory and credentials (2026-10-30)

- The principal lives in one row of `sensor.sensor_mqtt_directory`: username, tenant,
  sensor, `secret_hmac` and `secret_key_id` (migration 1826000000000). §1 puts the HMAC on
  the tenant `sensors` row; it is in the directory instead, so the broker's CONNECT and ACL
  checks are one indexed read with no tenant context. The tenant row keeps only
  `mqtt_username`, the link: checks keep it to the issued shape, off child rows and off
  suspended rows.
- The database keeps the two sides one fact. A trigger on every tenant's `sensors` table
  removes the route when the username is cleared or changed or the sensor deleted; a
  constraint trigger checked at commit refuses a sensor naming a username no route holds
  for it. So a route exists exactly while a live, unsuspended sensor holds it, and the broker
  needs no second read to know that.
- `SensorMqttIdentityService` is the one writer: it sets the username and inserts the route
  in one transaction, and withdraws by clearing the username. The entity marks
  `mqtt_username` insert- and update-false, and nothing else updates, deletes or ORM-saves a
  route (`tests/invariants/sensor-mqtt-identity-single-writer.spec.ts`).
- A tenant's routes go with the tenant. `MODULE_SCHEMAS[].tenantRouteTables` names the route
  tables (sensor: the edge device, provisioning key and sensor broker directories). Tenant
  erasure purges them (`RouteDirectoryPurgeHook`), and the db-migrate schema delete job
  purges them in the transaction that drops the schema (`purgeTenantRoutes`), because a
  DROP SCHEMA fires no row trigger. Before this the edge and key directories outlived a
  deleted schema too.
- The peppers are one keyring, `MQTT_SENSOR_SECRET_KEYRING`: a JSON array of
  `{ kid, secret, status }` with exactly one `active` key, the shape of
  `SERVICE_IDENTITY_KEYRING`. The deploy bootstrap generates it once per droplet
  (`scripts/deploy/lib/required-env-secrets.sh`); production refuses to start without it.
  A pepper rotates by adding a new active key and keeping the old one as `previous` until
  no sensor names it.
- `rotateSensorMqttCredentials` issues the first credential of a sensor registered before
  this ADR, or replaces the one it holds. Issuing removes the broker-connection settings
  from `protocol_configuration` (broker, free-text topic, wizard-typed credentials), so
  the legacy topic stops reaching the sensor once it holds a principal (§7).
- No `broker_mode` column. The platform broker is the only mode, so every MQTT sensor
  that talks to the broker (a standalone sensor or a parent) is a platform sensor, and a
  stored mode could only repeat that. The ADR for customer-operated brokers adds the
  discriminator together with its second value.
- §7 says wizard-typed broker credentials are stored in clear. They are encrypted at rest
  (AES-256-GCM since migration 1811000000000); they are still dead data, and issuing
  removes them.

### Broker acceptance and client-ID bindings (2026-10-30)

- `/mqtt/auth` refuses a CONNECT without a client ID. A service account connects only
  under its own client IDs: `sensor_service` under the listener's
  (`MQTT_CLIENT_ID` + `-main`, `sensorServiceListenerClientId`) and the legacy publishers'
  still on it (`LEGACY_SENSOR_SERVICE_PUBLISHERS`, SENSOR-HIGH-207). No platform component
  connects as `backend_service` or `alert_service`, so neither admits a session. Every
  other principal presenting one of those IDs is refused.
- A username of the issued shape is a sensor principal and is never looked up as an edge
  device. `SensorMqttBrokerAccess` admits it when the client ID is the username, its
  directory row exists and the secret verifies; and grants it PUBLISH to its own data topic
  only. Each check reads that one row.
- No service account holds an access with the write bit on a sensor data topic;
  `sensor_service` reads and subscribes there, `alert_service` keeps its read grant.
- The broker ACL spec runs on the real broker in CI (`sensor-service:test:broker`, step
  "Run broker ACL tests on real Mosquitto" in `ci-affected.yml`) whenever the broker
  config, the harness or the MQTT auth and identity code changes. Production's go-auth
  cache is off (`mosquitto-production.conf`), which the harness boots from.
- The broker states `max_packet_size 1048576`, the edge gateway client's own limit.

### Ingestion route and data-driven activation (2026-10-30)

- The listener subscribes `tenants/+/sensors/+/data` (first in
  `SENSOR_SERVICE_SUBSCRIPTION_FILTERS`) and routes it before any edge handler to
  `SensorPrincipalIngestion`. In order: the erased-tenant tombstone, `retain=1` (the
  `MqttMessageHandler` now receives the packet's flags), the per-sensor rate cap, the wire
  size, the payload schema (`libs/event-contracts/src/schemas/sensor-data-payload.schema.ts`).
  Each drop is counted by reason (`sensor_principal_messages_dropped_total`).
- The stated numbers: at most 16 KiB per message; nesting three levels below the top object,
  64 keys or items per level, 256 characters per string; one message a second per sensor
  with a burst of ten; a payload `timestamp` is trusted from an hour before to a minute after
  the receive time.
- The sensor is read inside its tenant's boundary and must still hold its principal (a
  suspended sensor holds none). A channel value must be a JSON number. The readings are written through
  `SensorReadingRecorder`, the one writer the legacy topic route now shares, so the two
  routes cannot diverge on calibration, quality codes, placement or the `SensorReading`
  event.
- The first message that stores a reading promotes the sensor (`SensorDataPromotion`): the
  sensor and its children go from DRAFT or TEST_FAILED to ACTIVE with `isActive`,
  `last_seen_at` is stamped, `sensor_audit_logs` records it, and one
  `SensorRegistrationCompleted` (`connectionTestPassed = true`) is enqueued — in the
  reading's own transaction. The UPDATE's condition makes it happen once. The registration
  events are built in one module (`registration/sensor-registration-events.ts`).
- On the `control-plane` profile (ADR-022) the listener stays up for this route alone: the
  sidecar does not take the topic (§4), and a message on any other topic that still reaches
  the persistent session is not consumed a second time.
- The per-sensor collector (`DataIngestionService`), which dials an active MQTT parent's
  configured broker, never dials a sensor holding its own principal: that sensor has no
  broker of its own, and its data arrives on its topic.

### Lifecycle of a platform sensor (2026-10-30)

- MQTT is classified `platform-broker` (`protocol-implementation-status.ts`,
  `isActivatedByData`): the one rule every lifecycle path reads. The connection tester answers
  it without dialling or validating; the MQTT configuration schema asks for nothing, and a
  configuration naming a broker, port, topic, client ID, credential or a payload format other
  than JSON is refused.
- Both registration paths issue the credential (a standalone sensor's, or a parent's) in the
  registration transaction and return it once (`mqttCredentials`); they run no test, leave the
  sensor DRAFT, and enqueue `SensorRegistrationStarted` and `SensorRegistered` only — the
  data's promotion enqueues `SensorRegistrationCompleted`.
- `testSensorConnection` and `activateSensor` refuse it (`MQTT_IDENTITY_ACTIVATED_BY_DATA`);
  `updateProtocolConfig` leaves its status as it is.
- `suspendSensor` withdraws the credential in the transaction that suspends it, before the
  status changes, with the suspending user in the audit row. `reactivateSensor` returns it
  to DRAFT with no test and no credential; the device page issues a new one
  (`rotateSensorMqttCredentials`), whose data promotes it. §6 has reactivation rotate the
  credential itself; a credential nobody can read would be issued for nothing, so the issue
  is the separate, explicit step, and the old one stays dead either way.

### Wizard and device page (2026-10-30)

- Protocol info and the device's read model carry `activatedByData`, computed by the backend
  from the one classification, so the screens never compare protocol codes.
- The wizard asks an MQTT device for no broker settings and runs no test; both steps say why.
  The registration answer carries the credential, and the wizard shows it once — host, port,
  client ID, username, password, topic, the device settings and the message shape its sensors
  read — before it reports the registration done.
- The device page shows the username a device connects as, or that it holds none, and issues
  a new credential (`rotateSensorMqttCredentials`, asked first when one would be replaced).
  The mutation keeps no state (`gcTime: 0`) and the dialog holds the password only while it
  is open. Refusals are worded by their code.

### Device contract and the legacy list (2026-10-30)

- `sensorprotocols/mqtt-protocol.md` is the device contract above, replacing the client-form
  design that told sensors to retain readings, set a Will and publish under
  `sensors/{location}`.
- The pepper keyring's rotation is in `docs/runbooks/secret-rotation.md`.
- The legacy publishers (§7) are SENSOR-HIGH-207: the production codex simulator and the
  repository simulator. The repository simulator's broker authenticates from a password file,
  not the platform's HTTP backend, so it cannot admit an issued principal at all; moving it
  means running the platform broker image in the simulator stack, which that finding owns.

### Review corrections (2026-10-30)

Two independent reviews of the parts above (security, sensor domain) found no authentication
or authorization bypass; these corrections follow from them.

- The per-sensor rate cap is metered when the sensor publishes, at the broker's ACL check,
  before the principal is read (`SensorMqttBrokerAccess`), not at ingestion. Metering at
  ingestion dropped the backlog the broker delivers at once after a listener restart, and
  every redelivery spent a token. A PUBLISH over the cap is refused at the broker and counted.
- A held message for a tenant deprovisioned since is ACK-dropped (`tenant_inactive`) instead
  of being redelivered forever on the one shared connection, as the legacy route already does.
- Promotion starts from any status but ACTIVE and SUSPENDED: a sensor registered before this
  ADR may be left in PENDING_TEST or TESTING, which no test ends for it now.
- A protocol change away from MQTT withdraws the credential in the same transaction; a change
  to MQTT starts the sensor over in DRAFT. `testParentConnection` refuses a parent its data
  activates, like `testSensorConnection`.
- A payload `timestamp` may be any scalar; only RFC 3339 with an offset within the skew is the
  sample time. A device whose clock format is off still delivers its readings at arrival time.
- Only a legacy MQTT sensor without a principal claims a legacy topic
  (`SensorTopicCacheService`): before, any protocol's `topic` key could claim one across
  tenants. The legacy route and the per-sensor collector stop at a sensor that holds a
  principal, and issuing or withdrawing a credential enqueues `SensorConfigurationUpdated`.
- go-auth no longer asks the superuser endpoint (`auth_opt_disable_superuser`), one HTTP
  round trip less per check; an ACL denial is logged as a structured debug record with the
  username's fingerprint; a malformed keyring's error does not quote it.
