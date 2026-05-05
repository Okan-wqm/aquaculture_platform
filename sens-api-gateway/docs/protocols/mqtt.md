# MQTT — Wire Contract Reference

**Protocol role on this device:** publish/subscribe client against a cloud broker. `suderra-agent` publishes telemetry + status and subscribes to commands + configuration.

RFC 2119 keywords apply.

## 1. Standard + version

- Base: **OASIS MQTT Version 3.1.1**, OASIS Standard, 2014-10-29 (ISO/IEC 20922:2016).
- Transport: TCP (plain) or TCP over TLS (`mqtts://`), default TLS port `8883`.
- MQTT v5.0 (OASIS Standard 2019-03-07) is NOT enabled. `rumqttc = "0.25"` supports v5 on a separate client type; the current code path uses the v3.1.1 client only.
- Retained messages and LWT (Last Will and Testament) are used in the v3.1.1 shape.

## 2. Crate + feature flag

- Crate: `rumqttc = "0.25"` (`Cargo.toml:33`).
- TLS backend: `rustls` (pulled via `reqwest` and the default rumqttc features); no OpenSSL dependency.
- Feature flag: none (default build).
- Failover scaffolding lives in `src/mqtt_failover.rs` with `#![allow(dead_code)]`; the `FailoverMqttClient` is not wired (v1.3.4 README).

## 3. Supported operations

| MQTT packet | Direction | Status | Notes |
|-------------|-----------|--------|-------|
| `CONNECT` / `CONNACK` | outbound / inbound | PRESENT | v3.1.1 client ID `<username>-<device_code>` (`src/mqtt.rs:227`). `clean_session` configurable (`src/mqtt.rs:239`). |
| `PUBLISH` QoS 0 | outbound | PRESENT | Used for telemetry bursts where duplicate delivery is acceptable. |
| `PUBLISH` QoS 1 | outbound / inbound | PRESENT | Default for status + commands (`src/mqtt.rs:267`, `src/mqtt.rs:437`). |
| `PUBLISH` QoS 2 | outbound / inbound | NOT USED | The rumqttc client supports it; this agent does not publish or subscribe QoS 2. |
| `SUBSCRIBE` / `SUBACK` | outbound / inbound | PRESENT | Commands + config topics at QoS 1 (`src/mqtt.rs:521-530`). |
| Retained `PUBLISH` | outbound | PRESENT for LWT | Online status + LWT offline status are retained (`src/mqtt.rs:268`). |
| Retained `PUBLISH` on command topic | inbound | REJECTED | A retained payload on the command topic is refused at the command-handler layer (`src/mqtt.rs:64-67`) to defeat broker-replay attacks. |
| `PINGREQ` / `PINGRESP` | outbound / inbound | PRESENT | Keepalive configurable (`src/mqtt.rs:238`). |
| `DISCONNECT` graceful | outbound | PRESENT | Triggered on shutdown. |
| Shared subscriptions (`$share/`) | inbound | NOT SUPPORTED | Broker-side feature; the agent uses per-device topics and does not share a subscription. |
| MQTT v5 features (session expiry, user properties, reason codes, enhanced auth) | — | NOT IMPLEMENTED — ROADMAP, tracked under ORPHAN-EDGE-003 |

## 4. Wire format

The MQTT v3.1.1 packet shape is defined by OASIS MQTT-v3.1.1 § 2-3. This chapter does not re-print the normative bytes; the relevant agent-observable shape is:

- Maximum **inbound** packet size: `1 MiB` (`set_max_packet_size(1_048_576, 1_048_576)`, `src/mqtt.rs:245`). Inbound packets exceeding the limit are rejected by rumqttc before they are decoded; this is an anti-OOM guard against a malicious broker or in-path MITM.
- Maximum **application-layer** payload accepted from incoming `PUBLISH`: `1 MiB` (`MAX_MQTT_PAYLOAD`, `src/mqtt.rs:350`). Exceeding it causes the message to be logged and dropped before entering the work queue.
- Client ID: `<username>-<device_code>` (e.g. `tenant42-RPI-A1B2C3D4`). Deterministic so that a broker with `clean_session = false` can resume the session across restarts.
- LWT topic: resolves to the device status topic; payload is a JSON `StatusMessage` with `status = "offline"`, QoS 1, retain = true (`src/mqtt.rs:254-269`).
- Internal eventloop buffer: 500 (`INTERNAL_MQTT_BUFFER_SIZE`, `src/mqtt.rs:36`). The application-level incoming-message channel is also 500 (`MESSAGE_CHANNEL_CAPACITY`, `src/mqtt.rs:32`).

### 4.1 Topic namespace

| Topic purpose | Resolved pattern (example) |
|---------------|----------------------------|
| Telemetry | `tenants/<tenantId>/devices/<deviceId>/telemetry` |
| Status | `tenants/<tenantId>/devices/<deviceId>/status` (retained; also the LWT target) |
| Commands (subscribe) | `tenants/<tenantId>/devices/<deviceId>/commands` |
| Command responses | `tenants/<tenantId>/devices/<deviceId>/commands/response` |
| Config (subscribe) | `tenants/<tenantId>/devices/<deviceId>/config` |

Resolution is performed by `MqttTopics::resolve` (`src/config.rs:382-490`). A topic that contains a literal `<placeholder>` after resolution MUST be treated as a configuration defect.

## 5. Error handling

- Reconnect backoff: exponential `base * 2^(errors-1)` capped at `max_backoff_secs`, with full jitter in `[50 %, 100 %]` of the computed value (`src/mqtt.rs:473-501`). The 50 % floor prevents collapse; the upper jitter prevents thundering-herd reconnects across a fleet after a broker recovery.
- Channel-send retry on inbound-message delivery: 3 retries at 10 ms (`src/mqtt.rs:39-42`, `src/mqtt.rs:375-418`). After 3 failures, the message is dropped and an `ERROR` log line is emitted identifying the topic.
- Reason-codes: v3.1.1 `CONNACK` return codes (0-5) are surfaced via the rumqttc `Event::Incoming(Packet::ConnAck)` variant and logged.
- A `biased` `tokio::select!` loop ensures the poll future wins over the "receiver-dropped" channel close (`src/mqtt.rs:336-344`, comment EDGE-MEDIUM-005) — this prevents a race in which a partial inbound PUBLISH would be dropped mid-read.

## 6. Authentication + encryption

### 6.1 Authentication — current state

- **Username + password CONNECT frame** (`src/mqtt.rs:202-212`, `src/mqtt.rs:237`). The password is wrapped in `secrecy::Secret<String>` so that it zeroizes on drop.
- No client-certificate / mTLS binding to the MQTT identity.

This is the first MQTT-specific gap from `ORPHAN-EDGE-003`: broker-side authentication is not bound to a per-device cert. A compromised password equals a valid client. Mitigation today relies on: (i) per-device password (deterministic derivation from `device_code` is not performed — the YAML stores an explicit credential); (ii) TLS on the channel (section 6.2) so that credential harvesting over the wire is not practical. The architectural close-out for ORPHAN-EDGE-003 is per-device X.509 client certificates issued at provisioning and an `EXTERNAL` broker authenticator (Mosquitto `auth_external` or EMQX `mtls`).

### 6.2 Encryption — TLS

- TLS is controlled by `mqtt.tls.enabled` (YAML, `src/config.rs:225-263`). When enabled, the client uses the `rustls-native-certs` store.
- Minimum TLS version: `rumqttc` with the rustls transport accepts 1.2 and 1.3; no explicit version pin is applied in the edge build.
- SNI: the broker hostname is used as-is for SNI.
- Certificate pinning: NOT IMPLEMENTED. The client trusts any CA in the system store. Integrators who require pinning MUST deploy a custom CA-only trust store at the systemd unit level.

### 6.3 Replay protection

- Retained-message replay on the **command** topic is explicitly rejected at the command-handler boundary (`src/mqtt.rs:64-67`) — a broker-persisted retained command MUST NOT trigger an action.
- Command envelope freshness / nonce / signature validation is layered on top of the MQTT transport by the command envelope + signed-deploy subsystem (see `architecture/command-envelope.md`); it is NOT an MQTT property.

## 7. Configuration schema

```yaml
mqtt:
  broker: mqtt.suderra.com            # required — hostname or IP
  port: 8883                          # 1883 plain, 8883 TLS
  username: tenant42
  password: "********"                # zeroized on drop
  keepalive_secs: 60
  clean_session: false                # persistent session; broker retains QoS 1 messages
  tls:
    enabled: true
    ca_cert_path: /etc/suderra/ca.pem # optional — falls back to system store
    insecure_skip_verify: false
  topics:                              # placeholders: {tenantId}, {deviceId}
    telemetry: "tenants/{tenantId}/devices/{deviceId}/telemetry"
    status:    "tenants/{tenantId}/devices/{deviceId}/status"
    commands:  "tenants/{tenantId}/devices/{deviceId}/commands"
    commands_response: "tenants/{tenantId}/devices/{deviceId}/commands/response"
    config:    "tenants/{tenantId}/devices/{deviceId}/config"
```

## 8. Worked example

Online status publish after CONNECT (retained, QoS 1):

```
Topic:    tenants/42/devices/rpi-a1b2c3d4/status
Payload:
{
  "device_id": "rpi-a1b2c3d4",
  "device_code": "RPI-A1B2C3D4",
  "status": "online",
  "timestamp": "2026-04-24T12:00:00Z",
  "agent_version": "1.6.0",
  "uptime_seconds": 0
}
Retain:   true
QoS:      1
```

LWT delivered by the broker to subscribers when the TCP connection closes unexpectedly:

```
Topic:    tenants/42/devices/rpi-a1b2c3d4/status
Payload:  { ..., "status": "offline", "uptime_seconds": 0 }
Retain:   true
QoS:      1
```

## 9. Test coverage

- No unit `#[test]` blocks in `src/mqtt.rs` — the client is integration-test-only. The rumqttc test harness (mock broker `rumqttd`) is the practical test surface; integrators SHOULD add a rumqttd-based conformance test under `tests/` before shipping.
- Stress / soak is covered by `sens-api-gateway/tests/stress_test.rs` + `tests/resource_benchmark.rs`.
- Tier-1 HIL vs Mosquitto 2.0.x and EMQX 5.x is the RECOMMENDED acceptance matrix.

## 10. Interop certification status

- **OASIS MQTT v3.1.1 conformance**: no formal test-house report on file.
- **Broker matrix validated in-house**: Mosquitto 2.0.x (TLS + username/password), EMQX 5.x (TLS + username/password). HiveMQ not tested.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Username + password CONNECT frame | `src/mqtt.rs:202-212`, `src/mqtt.rs:237` |
| `rumqttc = "0.25"` | `Cargo.toml:33` |
| Inbound packet size cap 1 MiB | `src/mqtt.rs:245` |
| Application payload cap 1 MiB | `src/mqtt.rs:350` |
| LWT retained | `src/mqtt.rs:264-269` |
| Retained-command rejection | `src/mqtt.rs:64-67` |
| Exponential backoff + full jitter | `src/mqtt.rs:473-501` |
| `biased` select to avoid lost-frame race | `src/mqtt.rs:336-344` |
| Failover scaffolding present but NOT WIRED | `src/mqtt_failover.rs:1` |
| Client ID format | `src/mqtt.rs:227` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| M1 | Broker accepts CONNECT, `clean_session=false`, QoS 1 subscribe | `SUBACK` return codes include 1; eventloop logs `MQTT CONNECTED` |
| M2 | Broker publishes a retained message on the commands topic before subscribe | Message is delivered by the broker; command handler rejects it (`retain = true`); no action executed |
| M3 | Broker sends a `PUBLISH` 1.2 MiB payload | Dropped with `"Dropping oversized MQTT message"`; connection stays up |
| M4 | TCP RST mid-session | LWT fires broker-side; agent reconnects after exponential backoff + 50 %-full jitter |
| M5 | Incorrect username | `CONNACK` return code 4; reconnect loop retries |
| M6 | TLS handshake against broker with expired cert | rustls rejects; repeated exponential backoff; agent logs TLS error |
| M7 | 500 inbound messages in < 1 s while consumer is slow | After 3 retries the 4th full-channel attempt drops the message with an ERROR log; channel never deadlocks |
| M8 | Graceful SIGTERM | DISCONNECT sent; LWT not fired by broker |
| M9 | Attempt QoS 2 subscribe | Outside the agent's surface; broker behaviour is observable but agent never publishes QoS 2 |
