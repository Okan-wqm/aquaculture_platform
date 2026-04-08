# Research: MQTT Broker Security — TLS, Failover, Mosquitto PBKDF2 Authentication

**Topic:** Mosquitto MQTT broker production hardening — TLS configuration, PBKDF2-SHA512 auth, broker failover, tenant topic isolation.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [Cedalo: MQTT Authentication and Authorization on Mosquitto](https://www.cedalo.com/blog/mqtt-authentication-and-authorization-on-mosquitto/)
- [Cedalo: MQTT TLS/SSL Configuration Guide](https://www.cedalo.com/blog/mqtt-tls-configuration-guide/)
- [Eclipse Mosquitto: mosquitto-tls man page](https://mosquitto.org/man/mosquitto-tls-7.html)
- [Eclipse Mosquitto: mosquitto.conf man page](https://mosquitto.org/man/mosquitto-conf-5.html)
- [HiveMQ: Securing MQTT Systems](https://www.hivemq.com/blog/mqtt-security-fundamentals-securing-mqtt-systems/)
- [Azure IoT Operations: MQTT broker authentication](https://learn.microsoft.com/en-us/azure/iot-operations/manage-mqtt-broker/howto-configure-authentication)
- [Shawn Hymel: Using Mosquitto with SSL/TLS](https://shawnhymel.com/3085/how-to-use-the-mosquitto-mqtt-broker-with-ssl-tls/)

## Key Findings

1. **`allow_anonymous false`** mandatory in production. Default-open broker = CRITICAL.
2. **TLS mandatory in production.** Plaintext MQTT port (1883) closed; only TLS port (8883) exposed. Certificates MUST be CA-signed (Let's Encrypt or private CA), not self-signed in production.
3. **PBKDF2-SHA512 (`$7$` format)** is the only production-acceptable password hash in `mosquitto_passwd`. Older DES/MD5 formats = CRITICAL.
4. **Iteration count matters.** Mosquitto default for PBKDF2 is configurable — 600K iterations for HTTP-callable password verification, lower for file-based static checks. Use the highest count the hardware tolerates without impacting connection-establishment latency.
5. **Distinct certificate subjects** for CA, server, and clients. Broker rejects certificates with identical subjects. CN must match the hostname clients connect to. SAN fields for multi-host.
6. **Topic-level ACL** for multi-tenant isolation. Tenant A client must not be able to publish or subscribe to `tenants/{tenantB}/...`. ACL enforcement via Mosquitto's auth plugin or per-user ACL file.
7. **Broker failover** is NOT a Mosquitto core feature — use a bridge cluster or external HA (HAProxy → multiple mosquitto brokers with shared persistence). Application-level failover via client-side broker list + exponential backoff with jitter.
8. **Circuit breaker on reconnection** — lock-free atomics + CAS for contention-free operation. Naive mutex-based circuit breakers become bottlenecks on high-concurrency IoT workloads.
9. **TLS session resumption** (RFC 5077) reduces handshake cost on reconnect. Essential for constrained IoT clients.
10. **Credential rotation** — Mosquitto supports hot-reload of password file via SIGHUP. Rotation must be automated, not manual.

## Security Concerns
- `allow_anonymous true` in production = CRITICAL.
- Plaintext port 1883 exposed in production = CRITICAL.
- Self-signed cert in production = HIGH (unless a private CA infrastructure exists).
- PBKDF2 with < 100K iterations on HTTP-verified credentials = HIGH.
- Missing topic-level ACL allowing cross-tenant subscribe = CRITICAL.
- Hardcoded broker credentials in source/config (not in secrets manager) = CRITICAL.
- Missing TLS cert expiry monitoring = HIGH (service outage).
- Missing cert validation (`danger_accept_invalid_certs = true` equivalent) on client = CRITICAL.

## Performance Concerns
- Naive mutex circuit breaker on reconnect = HIGH (lock contention).
- Missing TLS session resumption = MEDIUM (connection overhead).
- Per-device connection storm on failover = HIGH (use jittered exponential backoff).
- Topic fan-out without QoS tuning: QoS 1 on high-frequency telemetry = MEDIUM (ack overhead); prefer QoS 0 for non-critical high-frequency data.
- Unbounded in-flight messages on slow subscriber = HIGH (broker memory exhaustion).

## Architectural Implications for sensor-expert reviews
- Any MQTT client configuration without TLS = CRITICAL.
- Any MQTT client configuration without cert validation = CRITICAL.
- Topic format that does NOT include `tenants/{tenantId}/devices/{deviceId}/...` = CRITICAL (cross-tenant risk).
- Reconnection without exponential backoff + jitter = HIGH (thundering herd on failover).
- Missing broker failover state machine = HIGH (single point of failure).
- Non-timing-safe credential comparison = HIGH (timing attack on auth).
- Missing certificate expiry monitor (>30d warning, >7d critical) = HIGH.

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → MQTT Architecture (Critical)`:
- All MQTT connections MUST enforce TLS with CA-validated certificates in production. Plaintext MQTT or `danger_accept_invalid_certs` = CRITICAL.
- Topic-level ACL MUST prevent cross-tenant publish and subscribe. Missing ACL enforcement = CRITICAL.
- Credential verification MUST use timing-safe comparison to prevent timing-channel attacks. Non-timing-safe comparison = HIGH.
- Reconnection MUST use exponential backoff with jitter; simple retry or no backoff = HIGH (failover thundering herd).
- Broker failover state machine MUST handle `connecting → connected → disconnecting → failing_over → reconnecting` transitions explicitly; ad-hoc reconnect logic = HIGH.
- TLS session resumption SHOULD be enabled to reduce reconnect cost on constrained edge devices.
- Certificate expiry MUST be monitored; expired cert = CRITICAL (service outage).
- Mosquitto password hashes MUST use `$7$` (PBKDF2-SHA512) format with iteration count ≥ the platform minimum documented in `security.rs`. Lower iteration / older hash = CRITICAL.
- Broker credentials MUST come from a secrets manager, not hardcoded in config files. Hardcoded = CRITICAL.
