# MQTT Topic Tree Reference

**Transport:** MQTT 3.1.1 via `rumqttc = "0.25"` (`Cargo.toml:32-33`). TLS 1.2+ (rustls) when `MqttConfig.tls.enabled=true` (`src/mqtt.rs:247-252`).
**Root namespace:** `tenants/{tenant_id}/devices/{device_id}/...` — sourced from `src/config.rs:1294-1324` (9 `default_*_topic()` functions) and resolved at `src/config.rs:441-485` (`MqttTopics::resolve`).
**Payload format:** JSON (UTF-8) for all 9 topics today. Binary artefact streams (firmware, bytecode) flow over separate control-plane paths described in `commands.rs`, not over these MQTT topics.
**Max packet size:** 1 MiB enforced at both broker and agent (`src/mqtt.rs:241-245` + `src/mqtt.rs:349-357`) to prevent pre-authentication OOM DoS.
**Session model:** persistent (`clean_session=false` default, `src/config.rs:297-301`) — QoS 1/2 messages queued by the broker survive disconnects. Client ID is deterministic: `{username}-{device_code}` (`src/mqtt.rs:227`).

## Topic tree

All 9 topics share the prefix `tenants/{tenant_id}/devices/{device_id}/`. Placeholders `{tenant_id}` and `{device_id}` are substituted at `MqttTopics::resolve` time; unresolved placeholders log a WARN and fail the session (`src/config.rs:516-538`).

| # | Topic suffix | Direction | QoS | Retain | Purpose | Payload type | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | `status` | edge → cloud | 1 (AtLeastOnce) | **true** | Device lifecycle: Online on connect, Offline on disconnect (Last Will) | `StatusMessage` | `src/mqtt.rs:264-269` (LWT), `src/mqtt.rs:535-559` (publish) |
| 2 | `telemetry` | edge → cloud | 1 | false | Periodic system + hardware metrics | `TelemetryMessage` | `src/mqtt.rs:562-593` |
| 3 | `responses` | edge → cloud | 1 | false | Command execution results | `CommandResponse` | `src/mqtt.rs:596-613` |
| 4 | `commands` | cloud → edge | 1 | (retained REJECTED — see below) | Remote command invocation | `CommandMessage` | `src/mqtt.rs:515-532` (subscribe); dispatcher `src/commands.rs:399-470` |
| 5 | `config` | cloud → edge | 1 | true (accepted) | Configuration hot-reload payload | JSON config object | `src/mqtt.rs:515-532` (subscribe); handler `src/commands.rs:3199` |
| 6 | `capabilities` | edge → cloud | 1 | true (boot-time) | Hardware capabilities report for auto-detection | `CapabilitiesReport` | `src/mqtt.rs:643-653` (`publish_raw`) |
| 7 | `io_data` | edge → cloud | 0 (AtMostOnce) | false | Real-time process-image tag values | `{ tags: {...}, ts: ISO8601 }` | `src/mqtt.rs:616-622` |
| 8 | `alarms` | edge → cloud | 1 | false | IEC 62682 alarm events | `AlarmEventBatch` | `src/mqtt.rs:625-631` |
| 9 | `lora_events` | edge → cloud | 0 | false | LoRaWAN uplink / join-accept / downlink events | `LoRaEvent` | `src/mqtt.rs:634-640` |

## QoS rationale

- **QoS 1** (AtLeastOnce) is used for every payload whose loss would create a visible data gap or control-loop failure (telemetry, status, responses, commands, config, capabilities, alarms).
- **QoS 0** (AtMostOnce) is used for `io_data` and `lora_events` where the next frame carries fresher state — losing an intermediate frame is acceptable because the most recent value is what matters for the consumer (`src/mqtt.rs:615` comment).

## Retain rationale

- `status` is retained=true so a new subscriber sees the current device state without waiting for the next heartbeat (`src/mqtt.rs:549`).
- `capabilities` is retained=true because the report is emitted ONLY at boot — a subscriber connecting mid-session must be able to read the current hardware inventory.
- `config` retained is ACCEPTED by the edge (inbound), because the cloud may post a retained config that every restarted agent should pick up on subscribe.
- `commands` retained inbound is **REJECTED**: `IncomingMessage.retain` (`src/mqtt.rs:60-67`) is propagated to the command handler, which rejects retained command messages to prevent replay attacks from broker-persisted messages (comment `src/mqtt.rs:64-66`).

## Subscribe patterns

The edge subscribes to exactly two topics at connect (`src/mqtt.rs:515-532`):

```
tenants/{tenant_id}/devices/{device_id}/commands
tenants/{tenant_id}/devices/{device_id}/config
```

Wildcard subscriptions are NOT used. A compromised neighbour device cannot eavesdrop on another device's commands without a broker ACL violation.

## Publish patterns

Outbound publishes target the 7 edge→cloud topics above. One-off publishes to non-standard topics are supported via `publish_raw(topic, payload)` (`src/mqtt.rs:643-653`) — used today ONLY for the boot-time capabilities report to a dynamic topic.

## Reconnect + resubscribe semantics

- `clean_session=false` (default) — on reconnect with `session_present=true`, the broker retains subscriptions; no resubscribe needed.
- If `session_present=false` (broker lost session), the agent automatically resubscribes (`src/mqtt.rs:432-448`).
- Exponential backoff with 50%+jitter: base doubled on each consecutive error, capped at `mqtt_reconnect_max_secs` (`src/mqtt.rs:473-510`). Prevents thundering-herd reconnection storms when broker recovers.

## Broker ACL model

**Today:** enforced at the broker side — Mosquitto or NATS-MQTT bridge (production droplet uses `docker-compose.droplet.yml`). The edge agent authenticates with username/password today (`src/mqtt.rs:237`) AND optional mTLS (`src/mqtt.rs:247-252`). The ADR-015 cert-is-identity-SSoT rule applies to the internal NATS bus, NOT to the edge MQTT hop — edge-to-broker auth is a separate mTLS path covered by `mtls` module (Sprint 6.8 wiring).

**Roadmap:** `mtls` module staged types (`src/main.rs:94-99`) implement per-leaf cert pinning + 2-phase rotation + TLS 1.3 cipher-suite allowlist + 6-gate `verify_leaf_cert` — these flip the edge MQTT transport to cert-is-identity parity with the ADR-015 NATS model.

## AsyncAPI 2.6 machine schema

See [`asyncapi.yaml`](./asyncapi.yaml) for the full machine schema with per-topic payload schemas, QoS / retain declarations, and direction (publish / subscribe) operations.

## Cross-references

- [`event-schemas.md`](./event-schemas.md) — field-by-field JSON Schemas for all 9 payload types.
- [`remote-commands.md`](./remote-commands.md) — catalogue of commands consumable on the `commands` topic.
- `sens-api-gateway/docs/protocols/mqtt.md` (owned by `protocol-reference-writer`) — wire-level MQTT transport detail.
- Cloud side: `libs/event-contracts/src/edge-device-events.ts` defines the NestJS-side shapes that sensor-service publishes AFTER reading from these MQTT topics — drift warnings in [`event-schemas.md`](./event-schemas.md#contract-drift-warnings).
