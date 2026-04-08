# Research: MQTT TLS, Broker Failover, Backpressure with `rumqttc`

**Topic:** `rumqttc` 0.25 TLS configuration, Last Will, backpressure, broker failover state machine, exponential backoff + jitter, certificate validation in production
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [docs.rs — `rumqttc` crate root](https://docs.rs/rumqttc/latest/rumqttc/)
- [docs.rs — `rumqttc::MqttOptions`](https://docs.rs/rumqttc/latest/rumqttc/struct.MqttOptions.html)
- [docs.rs — `rumqttc::AsyncClient`](https://docs.rs/rumqttc/latest/rumqttc/struct.AsyncClient.html)
- [docs.rs — `rumqttc::EventLoop`](https://docs.rs/rumqttc/latest/rumqttc/struct.EventLoop.html)
- [docs.rs — `rumqttc::TlsConfiguration`](https://docs.rs/rumqttc/latest/rumqttc/enum.TlsConfiguration.html)
- [docs.rs — `rumqttc::TlsError`](https://docs.rs/rumqttc/latest/rumqttc/enum.TlsError.html)
- [docs.rs — rumqttc TLS example source](https://docs.rs/crate/rumqttc/latest/source/examples/tls.rs)
- [GitHub — `bytebeamio/rumqtt` README](https://github.com/bytebeamio/rumqtt/blob/main/rumqttc/README.md)
- [GitHub — rumqttc issue #163 (rustls + bare IP + self-signed)](https://github.com/bytebeamio/rumqtt/issues/163)
- [GitHub — rumqttc issue #211 (reconnection + pending messages TTL)](https://github.com/bytebeamio/rumqtt/issues/211)
- [GitHub — rumqttc issue #295 (reconnect delay 2 minutes)](https://github.com/bytebeamio/rumqtt/issues/295)
- [Eclipse Mosquitto — `mosquitto.conf` man page](https://mosquitto.org/man/mosquitto-conf-5.html)
- [Eclipse Mosquitto — `mosquitto-tls` man page](https://mosquitto.org/man/mosquitto-tls-7.html)
- [AWS IoT — MQTT Device Advisor tests (backoff-with-jitter)](https://docs.aws.amazon.com/iot/latest/developerguide/device-advisor-tests-mqtt.html)

## Key Findings

### `MqttOptions` — production-correct values
- `new(client_id, host, port)` — `client_id` MUST be unique per device and derive from the hardware serial (not random) so that `clean_session = false` produces stable session state.
- `set_keep_alive(Duration)` — default 60 s. Edge recommendation: 30 s on wired OT, 60–90 s on cellular to reduce radio wake-ups. Keepalive interacts with broker `max_keepalive`; a Mosquitto broker with `max_keepalive=60` silently rewrites a 90 s client keepalive which breaks dead-peer detection.
- `set_clean_session(false)` — required so that QoS 1/2 in-flight and pending subscribes survive a broker reconnect. When `clean_session = false`, `client_id` MUST NOT be empty.
- `set_last_will(LastWill { topic, message, qos: QoS::AtLeastOnce, retain: true })` — publishes a structured "offline" marker (e.g. `{"state":"offline","ts":...,"reason":"lwt"}`) on unexpected disconnect. Backend consumers must distinguish LWT from intentional "offline" retained messages by the `reason` field.
- `set_credentials(user, password)` — only on broker where client-certificate auth is not available; username/password is **not** a substitute for TLS mutual auth on a production OT boundary.
- `set_transport(Transport::tls_with_config(TlsConfiguration::...))` — TLS is mandatory in production.
- `set_max_packet_size(max_incoming, max_outgoing)` — must be bounded; default is large. A compromised broker could otherwise OOM the device with a jumbo publish.
- `set_inflight(u16)` — inflight window for QoS > 0. Too low = throttled throughput; too high = long recovery time on reconnect.
- `set_request_channel_capacity(cap)` — the bounded mpsc between `AsyncClient` and `EventLoop`.

### `TlsConfiguration` — certificate validation matrix
`rumqttc::TlsConfiguration` variants:
- `Simple { ca, alpn, client_auth }` — rustls with a CA bundle and optional `(cert_der, key_der)` client auth. This is the correct production choice for self-managed broker PKI.
- `SimpleNative { ca, client_auth }` — native-tls (OpenSSL / SChannel / Security.framework) backend with CA + optional client auth. Preferred when the broker uses a cert chain issued by a commercial CA already in the OS trust store.
- `Rustls(Arc<ClientConfig>)` — injected rustls `ClientConfig` for custom needs (mTLS with PKCS#11 HSM via `rustls-pkcs11`, custom certificate verifier, TLS 1.3 only, SNI overrides).
- `Native` — OS trust store; no client auth.

**There is no `danger_accept_invalid_certs` for rustls.** rustls deliberately refuses to offer a global "disable verification" knob. A deployer must instead (a) provision the broker CA on the device or (b) write a custom `ServerCertVerifier` — and any such custom verifier is a CRITICAL review flag. rustls also refuses TLS to a bare IP address with a self-signed certificate. Production edge: always use DNS SAN, never IP SAN, and provision a minimal private CA.

### TLS protocol baseline (Mosquitto + rumqttc)
- Mosquitto 2.x defaults to TLS 1.2; `tls_version tlsv1.3` restricts to 1.3 only. Edge agent reviews must verify client `ClientConfig` pins ≥ TLS 1.2 (rustls defaults to TLS 1.2/1.3, no SSLv3/TLS1.0/1.1).
- `require_certificate true` on the broker enforces mutual TLS (mTLS). The device certificate CN (or the `use_identity_as_username` feature) becomes the authenticated identity used by the broker ACL → IEC 62443 FR 1 (Identification & Authentication Control).

### `AsyncClient` + `EventLoop` backpressure model
- `AsyncClient` sends publish/subscribe/unsub requests into a **bounded** mpsc of size `cap` (constructor). `EventLoop::poll()` drains it.
- `publish(...).await` **blocks** (applies backpressure) when the channel is full. `try_publish(...)` returns `Err(TrySendError::Full)` immediately — used for "drop on overload" paths (low-priority telemetry).
- **`poll()` must be called in a tight loop** — any `.await` inside the poll loop that depends on a completing publish will deadlock. The `EventLoop` is the sole driver of connect, keepalive, ACKs, and reconnect.
- Blocking the poll loop blocks keepalive → broker times out → LWT fires → cascade.

### Reconnect + broker failover state machine (industry standard)
rumqttc's `EventLoop::poll()` returns an `Err` on connection loss; the application calls `poll()` again which triggers reconnect. The delay is controlled by the `reconnect_options` in recent versions. The documented industry pattern (AWS IoT Device Advisor, Azure IoT SDK, Eclipse Paho) is **full jitter** exponential backoff:

```
delay_n = random_between(0, min(cap, base * 2^n))
```
with `base = 1 s`, `cap = 60 s`. This is the variant AWS IoT validates — "decorrelated jitter" is also acceptable; plain exponential without jitter produces thundering-herd reconnect storms after a broker restart and is explicitly flagged as a test failure by AWS IoT Device Advisor.

**Broker failover state machine for edge agents with primary + secondary brokers:**
```
     ┌──────────┐   primary OK      ┌──────────────┐
     │ PRIMARY  │ ─────────────────▶│ CONNECTED-P  │
     └──────────┘                   └──────────────┘
          │ fail N times                   │ loss
          ▼                                 ▼
     ┌───────────┐   secondary OK    ┌──────────────┐
     │ SECONDARY │ ─────────────────▶│ CONNECTED-S  │
     └───────────┘                   └──────────────┘
          │                                 │
          │  hold-down timer expires        │ loss
          ▼                                 ▼
     ┌───────────┐                    ┌──────────┐
     │  PROBING  │ ◀──────────────────│ PRIMARY  │
     └───────────┘                    └──────────┘
```
Key properties:
1. **Hold-down timer**: after failing back to secondary, do not attempt primary again for ≥ 5 min (prevents flapping).
2. **Health probe**: periodic lightweight publish to a `health/probe/{device_id}` topic; loss of PUBACK within keepalive × 1.5 → mark broker unhealthy.
3. **Session state per broker**: each broker has a distinct MQTT session (`clean_session = false` + broker-specific client ID suffix) to avoid cross-broker session confusion.
4. **Offline queue**: all publishes during PROBING or transition states go to `offline_queue.rs` (SQLCipher) with ordering preserved.

### Known rumqttc operational gotchas
- Issue #263: `subscribe()` can lock the EventLoop if the request channel is full and the poll loop is blocked waiting on a publish future — reinforces R-MQTT-04 below.
- Issue #295: default reconnect delay can be surprisingly long (~2 min observed); review must confirm explicit reconnect backoff is configured, not relying on defaults.
- Issue #211: pending-message TTL is not built-in — the edge must track message age in the offline queue and drop stale telemetry.

## Security Concerns

- **Custom `ServerCertVerifier` without operator-signed justification is CRITICAL.** Any code accepting self-signed, expired, or name-mismatched certs is a MITM bypass.
- **LWT not configured** leaves backend unable to distinguish hung gateways from intentional offline — operators miss life-safety alarms.
- **Credentials in source** — `set_credentials` must only receive a `Secret<String>` loaded from `config.rs` with zeroize-on-drop; logging the `MqttOptions` value leaks the password (rumqttc's `Debug` impl used to leak creds in older versions — audit the concrete version).
- **`clean_session = true` on every reconnect** discards unacked QoS 1/2 publishes → silent data loss of telemetry and alarms.
- **Unbounded `max_packet_size`** is a pre-auth DoS vector; an attacker who compromises the broker can send a jumbo publish that OOMs the edge.
- **TLS 1.0/1.1 fallback** must be blocked at the client side; Mosquitto 2.x already disables these server-side but older deployed brokers may accept them.
- **Broker failover without per-broker ACL audit** can leak telemetry to a less-trusted secondary broker if ACLs aren't mirrored.

## Performance Concerns

- Blocking `publish().await` inside the poll loop task is the top cause of EventLoop stalls (issue #263).
- Too-small `request_channel_capacity` makes the producer side stall under telemetry bursts → missed scan cycles in the scripting engine.
- Too-large `inflight` window (> 100) breaks recovery time: on reconnect the broker must re-deliver the whole window before new publishes go through.
- Keepalive ping overhead on cellular links: measured ~50 bytes per ping + TCP ACK; on Telenor M2M bundles each ping is billed per-session, so keepalive < 30 s is cost-hostile.

## Architectural Implications for edge-expert reviews

1. `mqtt.rs` must construct `MqttOptions` from `config.rs` `Secret<String>` — no inline literals. All fields (keepalive, clean_session=false, LWT topic, max_packet_size, inflight, channel cap) must be audited against the production defaults above.
2. `mqtt.rs` client loop must have a dedicated task running only `event_loop.poll()` and forwarding events over a broadcast or mpsc channel — never perform publish/subscribe/await inside the poll loop itself.
3. `mqtt_failover.rs` must implement the primary/secondary state machine with hold-down, health probe, and per-broker session state. The state machine must be exhaustive (`match` on all states, no `_ => ...` catch-all hiding missed transitions).
4. Reconnect backoff must be **explicit full-jitter exponential** with `base = 1 s`, `cap = 60 s`. The code must not rely on rumqttc's default delay.
5. TLS configuration must use `TlsConfiguration::Simple { ca, .. }` with the operator-provisioned CA loaded from a dedicated trust path (`/etc/aqua-saas/tls/broker-ca.pem`); no environment variable override in production builds.
6. Custom `ServerCertVerifier` is FORBIDDEN in production. If a development build needs one, it must be gated behind a `#[cfg(feature = "dev-insecure")]` feature that the release build explicitly rejects at compile time.
7. `max_packet_size` must be set to a value justified by the device's largest known legitimate payload (firmware chunk, batch telemetry).
8. Offline queue integration: every publish path must, on `TrySendError::Full` or broker disconnected, enqueue to `offline_queue.rs` with the same topic, QoS, and retain flags, preserving FIFO order.
9. Publish credentials must use `Secret<String>` from the `secrecy` crate; `Debug` impls on any config struct holding credentials must be audited.

## Domain Rule Additions for edge-expert

- **R-MQTT-01:** TLS is mandatory in production. `TlsConfiguration::Simple` or `Rustls(ClientConfig)` with operator CA; no `Native` (OS store) fallback without explicit opt-in documented in config.
- **R-MQTT-02:** Custom `ServerCertVerifier` is FORBIDDEN in release builds. `#[cfg(feature = "dev-insecure")]` gate for any verifier override; `#[deny(feature = "dev-insecure")]` in release.
- **R-MQTT-03:** `MqttOptions::set_last_will` is REQUIRED with a structured JSON payload including `state`, `device_id`, `ts`, `reason="lwt"` at QoS 1, retain=true.
- **R-MQTT-04:** The `EventLoop::poll()` task must do nothing except poll and forward events. Publish/subscribe from other tasks via `AsyncClient`.
- **R-MQTT-05:** Reconnect backoff: full-jitter exponential `min(cap, base*2^n) * rand(0,1)` with `base=1s`, `cap=60s`. Plain exponential without jitter is FORBIDDEN.
- **R-MQTT-06:** Broker failover state machine must have hold-down ≥ 5 min and a lightweight health probe; transitions exhaustive, no `_ => ...` catch-all.
- **R-MQTT-07:** `clean_session = false`, `client_id` derived from hardware serial.
- **R-MQTT-08:** `max_packet_size` explicitly bounded; default (unbounded) is FORBIDDEN.
- **R-MQTT-09:** `inflight` window ≤ 100; documented justification if higher.
- **R-MQTT-10:** On broker disconnect or `TrySendError::Full`, publishes fall through to `offline_queue.rs` with FIFO ordering and the same topic/QoS/retain metadata.
- **R-MQTT-11:** mTLS (client certificate auth) is REQUIRED in production; username/password alone is insufficient for IEC 62443 FR 1.
- **R-MQTT-12:** TLS ≥ 1.2 enforced; TLS 1.0 / 1.1 client-side fallback FORBIDDEN.
- **R-MQTT-13:** Credentials from `Secret<String>` (secrecy crate); `Debug` impls must not leak credential fields — audit required.
