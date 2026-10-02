# Sensor ingestion and edge gateway — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `sensor-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | apps/sensor-service, sensor-ingestion sidecar, NATS DLQ, edge gateway (sens-api-gateway) |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The ingestion path loses data silently, and commands to devices are protected only by the MQTT
password.

## Ranked blockers

- **B1. A failed DB write still acks the reading, so it is lost.** In
  `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:348-357` the handler's `.catch(() =>
  recordMessageFailed())` swallows `DurableWriteError`. `dispatchDurable`
  (`shared-mqtt/mqtt-client.service.ts:592-596`) then sends the ack, so the broker never
  redelivers. The test skips the real handler (`__tests__/mqtt-listener.service.spec.ts:271-272`,
  `void handler`). The main edge path (`tenants/...`) also swallows every error (`:1234`,
  `:1530`). SENSOR-CRITICAL-086 (marked RESOLVED) has regressed.
- **B2. Edge history is dropped and stored with the wrong time.** `io_data` is throttled to 1 Hz
  before it is saved (`:1432-1438` runs before `:1458`). Saved rows get the cloud's arrival time
  (`:1500`). Nothing in `apps/` reads `edge_seq`, even though the edge stamps it
  (`sens-api-gateway/src/publish_helpers.rs:100-103`). After an outage the edge's buffered backlog
  is mostly dropped and nothing is de-duplicated. The cloud half of EDGE-CRITICAL-004 was never
  built.
- **B3. The dead-letter queue cannot work in production.** No service may publish to `dlq.>`
  (`infrastructure/nats/services.yaml:822-832`, generated `nats.conf`). The dead-letter publish
  fails, the message is NAK'd, and it is redelivered forever
  (`platform/libs/event-bus/src/nats/nats-event-bus.ts:1504-1506`, `:1566-1568`).

## Major

- **M4. Commands are unsigned.** The cloud sends unsigned command envelopes
  (`vfd/services/vfd-edge-write.service.ts:49-55`). `SENSOR_COMMAND_SIGNING_KEY_SEED_HEX` is set
  in no compose file. The edge defaults to `SignatureMode::Disabled`
  (`command_envelope/envelope.rs:70`). RBAC manifest, audit sink and keystore are also off by
  default (`config.rs:1703`, `:1824`, `:1890`).
- **M5. A "failed" command can still run minutes later.** The cloud times out and records failure
  after 10 s (`vfd-edge-write.service.ts:59`, `:103-113`). The edge keeps its session across
  reconnects (`clean_session: false`) and accepts commands up to 300 s old (`config.rs:3072`,
  `commands/mqtt_dispatch.rs:259-276`). A START or frequency change can reach the drive minutes
  after the operator saw "failed".
- **M6. The edge HMI WebSocket can drive actuators without checks.** With no package loaded,
  commands run directly (`scada_server.rs:1425-1434`). "Confirm" is just the client echoing back
  (`:1565-1587`). The auth token is optional even when the server is bound to the OT network card
  (`:1100`, `:2277`). This is in the shipped `scada-display` build.
- **M7. Capacity is unproven.**
  - The perf baseline is all TBD (`docs/perf/baseline-2026-04.md:149-152`).
  - The deploy capacity gate still uses the old 1920 MiB floor
    (`scripts/deploy/droplet-capacity.sh:78`) and the JetStream alert still assumes 2 GiB
    (`35-broker-jetstream.yml:25-35`).
  - Mosquitto runs on 128M / 0.15 CPU and makes an HTTP ACL call per publish
    (`docker-compose.droplet.yml:661-664`).

## Minor

- **The sensor-ingestion sidecar cannot start as mounted.**
  `infrastructure/sensor-ingestion/config.toml:27` points at `mqtts://mosquitto:8883`, but the
  broker only listens on 1883; `:51` still holds the password placeholder. It is pilot-gated, so
  no tenants use it yet.
- **No production edge release exists.** rc4 is labelled "Historical RC only" and Cargo is still
  `2.0.0-rc.4`. Still open from its notes: the OPC UA client runs with `SecurityPolicy#None`, and
  dispatcher RBAC is a follow-up.

## Registry check

- SENSOR-CRITICAL-108: PARTLY STALE. `nats.conf:20` is now 10GB, but the capacity gate and the
  alert rule are still stale. Keep it OPEN.
- SENSOR-HIGH 090, 093 (the NATS permission gap makes it worse), 105
  (`ARCHIVE_CODEC_ID='columnar-jsonl'`), 106, 113, 061, 068, 069, 070, 079: CONFIRMED.
- SENSOR-HIGH-091: PARTIAL. A NATS exporter exists, but there is no per-consumer (surveyor) view,
  no Mosquitto exporter, and no alert on failed messages.
- SENSOR-HIGH-097: likely STALE (tombstone and erasure hooks are in place). SENSOR-HIGH-116: STALE
  (the Apply button is gone).
- SENSOR-HIGH-080: PARTIAL. I2C outputs are now in safe-state (`safe_state.rs:68`), but the writes
  to actuators are still untested. SENSOR-HIGH 060, 073, 076: not verified.
- EDGE-HIGH-013, 023 (`sens-api-gateway-ci.yml:217-224`; `cargo check` in `ci-edge.yml` does not
  run clippy), 024 (only `strict-security` gates any code), 025 (`main.rs` is 6328 lines):
  CONFIRMED.
- EDGE-HIGH-019: PARTIAL. The default mode now rejects legacy OTA (`firmware.rs:97`), but
  Permissive mode still installs unsigned firmware (remote code execution).

## Not verified

- Real droplet disk and resources, live broker behaviour, actual load numbers,
  hardware-in-the-loop safe-state on aerators, whether Postgres serves TLS for the sidecar, how
  alert-engine consumers behave, and the OPC UA runtime.

## Registry entries

This review appended 8 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| SENSOR-CRITICAL-136 | CRITICAL | A failed database write still acks the sensor reading so it is lost: the MQTT handler catch swallows DurableWriteError and dispatchDurable then sends the ack, the main edge path swallows every error, and the test skips the real handler, so SENSOR-CRITICAL-086 (RESOLVED) has regressed |
| SENSOR-CRITICAL-137 | CRITICAL | Edge history is dropped and stored with the wrong time: io\_data is throttled to 1 Hz before it is saved, rows get the cloud arrival time, and nothing in apps/ reads the edge\_seq the edge stamps, so after an outage the buffered backlog is mostly dropped and not de-duplicated; the cloud half of EDGE-CRITICAL-004 was never built |
| SENSOR-CRITICAL-138 | CRITICAL | The dead-letter queue cannot work in production: no service identity may publish to dlq.>, so the dead-letter publish fails, the message is NAK'd and redelivered forever |
| EDGE-HIGH-047 | HIGH | Device commands are unsigned: the cloud sends unsigned command envelopes, SENSOR\_COMMAND\_SIGNING\_KEY\_SEED\_HEX is set in no compose file, the edge defaults to SignatureMode::Disabled, and the RBAC manifest, audit sink and keystore are also off by default |
| EDGE-HIGH-048 | HIGH | A command the cloud recorded as failed can still run minutes later: the cloud times out after 10 s while the edge keeps its session (clean\_session false) and accepts commands up to 300 s old, so a START or frequency change can reach the drive after the operator saw "failed" |
| EDGE-HIGH-049 | HIGH | The edge HMI WebSocket can drive actuators without checks: with no package loaded commands run directly, "Confirm" is just the client echoing back, and the auth token is optional even when the server is bound to the OT network card, in the shipped scada-display build |
| EDGE-MEDIUM-050 | MEDIUM | No production edge release exists: rc4 is labelled Historical RC only and Cargo is still 2.0.0-rc.4, the OPC UA client runs with SecurityPolicy#None and dispatcher RBAC is a follow-up |
| SENSOR-LOW-139 | LOW | The sensor-ingestion sidecar cannot start as mounted: config.toml points at mqtts://mosquitto:8883 but the broker only listens on 1883, and the password is still a placeholder |
