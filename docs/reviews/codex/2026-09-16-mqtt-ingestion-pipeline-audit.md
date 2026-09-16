# MQTT ingestion pipeline audit — codex live-droplet session (2026-09-16)

Live end-to-end wiring of an external MQTT water-quality sensor on the test
droplet (project aqua-saas) surfaced seven latent defects in the sensor data
path. Every item below was reproduced against the running stack (broker logs,
SQL against the tenant schema, GraphQL through the gateway) before being fixed
in this branch.

## F1 — wizard/parent registration never creates ingestible channels

`registerParentWithChildren` persists each child's `dataPath` on the child
`sensors` row only; the MQTT listener resolves the topic to the PARENT sensor
and reads `sensor_data_channels` of that sensor alone. Wizard-registered MQTT
devices therefore ingest zero rows, silently. Compounded by F1b: every input
class in `data-channel.dto.ts` lacked class-validator decorators, so the global
`whitelist + forbidNonWhitelisted` pipe rejected `dataChannels` payloads and
the `createDataChannel` / `saveDiscoveredChannels` mutations at the boundary.

## F3 — one denied subscription filter kills the whole listener batch

The listener subscribes in a single SUBSCRIBE packet including
`+/+/+/temperature-array`, which matches no `sensor_service` ACL rule; the
resulting 0x80 fails the entire batch, leaving the listener connected but
subscribed to nothing. Additionally Mosquitto 2.x checks wildcard SUBSCRIBEs
with acc=4 (MOSQ_ACL_SUBSCRIBE) while the `tenants/+/devices/+/*` grants only
allowed acc 1|3. Verified live: broker showed no aqua-sensor-service
subscriptions at all after boot.

## F4 — RLS deny-by-default blinds the tenant-agnostic topic cache

`RlsConnectionBootstrapService` SETs `app.bypass_rls='off'` on every pooled
connection outside a request context, while tenant schemas carry FORCE RLS.
`SensorTopicCacheService` cross-schema reads therefore return zero rows: MQTT
messages cannot resolve sensors even when registration and channels are
correct. Verified live via `current_setting('app.bypass_rls')` probe returning
'off' inside the service while the same query as the same role in psql
returned the sensor.

## F5 — warm-up row-mapping alias bug

`warmUpCache` selected `protocol_configuration` (snake_case) but read
`sensor.protocolConfiguration`; every topic read as undefined and the log said
"Cache warmed up: 0 sensors" forever.

## F7 — NULL channel bounds mark every reading BAD

TypeORM hydrates nullable numeric bounds as `null`; the `!== undefined` guards
made `value > null` (coerced 0) fail, so any positive reading on a channel
without explicit physical bounds got quality_code 0 (BAD) + 0x20.

## F6 — hand-written frontend queries drift from the backend schema

`DeviceDetailPage` selected object-typed `connectionStatus` bare; the same
class of drift exists in `useSensorRegistration` / `sensorRegistrationApi`
(`status`, `protocolId`, bare `connectionStatus`) and `useWidgetData`
(`alertThresholds` not served on `RegisteredSensorType`). All verified against
the live gateway. Contract tests + canlı-SDL fixture close the class.

## F8 — dead listener deploys green

No MQTT state in `/health/ready`, no required boot signal for subscriptions,
and the Grafana MQTT panels query metric names that are registered nowhere.
A silently-unsubscribed listener therefore passes every deploy gate.
