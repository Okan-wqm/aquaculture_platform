# Research: NATS JetStream + Mosquitto Docker Deploy — TLS, Accounts, Subject ACL, PBKDF2

**Topic:** Messaging broker production hardening in Docker — NATS JetStream with TLS, accounts-based multi-tenancy, subject-level ACL; Mosquitto with PBKDF2 auth, persistent volumes, health checks.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [NATS Docs: Security Overview](https://docs.nats.io/nats-concepts/security)
- [NATS Docs: Securing NATS (TLS, auth, authz)](https://docs.nats.io/running-a-nats-service/configuration/securing_nats)
- [NATS Docs: Enabling TLS](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/tls)
- [NATS Docs: TLS Mutual Auth](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro/tls_mutual_auth)
- [NATS Docs: Multi-tenancy with Accounts](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts)
- [NATS Docs: JetStream (persistence, replication)](https://docs.nats.io/jetstream)
- [NATS Docs: Authorization (subject permissions)](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization)
- [Eclipse Mosquitto: mosquitto.conf man page](https://mosquitto.org/man/mosquitto-conf-5.html)
- [Eclipse Mosquitto: mosquitto_passwd man page](https://mosquitto.org/man/mosquitto_passwd-1.html)
- [Eclipse Mosquitto: Docker Hub Official Image](https://hub.docker.com/_/eclipse-mosquitto)
- [Cedalo: Mosquitto authentication & authorization](https://www.cedalo.com/blog/mqtt-authentication-and-authorization-on-mosquitto/)
- [HiveMQ: MQTT Security Fundamentals](https://www.hivemq.com/blog/mqtt-security-fundamentals-securing-mqtt-systems/)
- [OWASP IoT Top 10](https://owasp.org/www-project-internet-of-things/)

## Key Findings — NATS JetStream

1. **TLS on all listeners.** Client (4222), cluster (6222), leafnode (7422), monitoring (8222), gateway (7522). Plaintext 4222 = CRITICAL. Config:
   ```
   tls {
     cert_file: "/etc/nats/certs/server.pem"
     key_file:  "/etc/nats/certs/server-key.pem"
     ca_file:   "/etc/nats/certs/ca.pem"
     verify:    true              # mTLS — client must present valid cert
     cipher_suites: [
       "TLS_AES_128_GCM_SHA256",
       "TLS_AES_256_GCM_SHA384",
       "TLS_CHACHA20_POLY1305_SHA256"
     ]
     curve_preferences: ["X25519", "P-256"]
     timeout: 5
   }
   ```

2. **`verify: true` for mTLS.** Without it, server presents cert but doesn't validate client cert → TLS without authentication. Combine with `verify_and_map` to use cert CN/SAN as the authenticated user identity. Missing `verify: true` on client port in production = CRITICAL.

3. **Accounts for multi-tenancy.** NATS accounts provide isolated subject namespaces. Each tenant (or each service group) gets its own account; cross-account communication requires explicit `exports`/`imports`. Example:
   ```
   accounts {
     SYS: { users: [ { user: sys, password: "$2a$..." } ] }
     PLATFORM: {
       jetstream: { max_mem: 512MB, max_file: 10GB, max_streams: 50, max_consumers: 100 }
       users: [
         { user: "platform", password: "$2a$...", permissions: {
           publish:   { allow: ["platform.>"] }
           subscribe: { allow: ["platform.>", "_INBOX.>"] }
         }}
       ]
     }
     FARM: {
       jetstream: { max_mem: 256MB, max_file: 5GB }
       users: [
         { user: "farm", password: "$2a$...", permissions: {
           publish:   { allow: ["farm.>"] }
           subscribe: { allow: ["farm.>", "platform.events.>", "_INBOX.>"] }
         }}
       ]
     }
   }
   system_account: SYS
   ```
   Single account for all services in multi-tenant SaaS = HIGH (cross-service subject leakage).

4. **Subject-level ACL with allow/deny lists.** `permissions.publish` and `permissions.subscribe` each accept `allow` and `deny`. Principle of least privilege: explicitly allow only the subjects the service needs.
   ```
   permissions: {
     publish:   { allow: ["sensor.readings.>", "sensor.alerts.>"], deny: ["sensor.readings.admin.>"] }
     subscribe: { allow: ["config.sensor.>", "_INBOX.>"] }
   }
   ```
   Wildcard `>` permissions with no deny = HIGH. Missing permissions (defaulting to allow-all for the user) = CRITICAL.

5. **JetStream quotas per account.** `max_mem`, `max_file`, `max_streams`, `max_consumers` enforce resource limits per tenant. Without quotas, a runaway producer in one account can exhaust disk for all tenants = HIGH.

6. **Passwords hashed with bcrypt.** NATS accepts `$2a$` bcrypt hashes in config (generate with `nats server passwd`). Plaintext passwords in config = CRITICAL. Rotate via config reload + SIGHUP or operator JWT model.

7. **Operator JWT model (decentralized auth) for larger deployments.** NATS supports NKey signed JWTs where each account has its own private key and mints user JWTs without server config changes. More complex but better for dynamic tenants. Suitable when account count is large or tenants self-service.

8. **Monitoring endpoint (`/varz`, `/connz`, `/jsz`) MUST be restricted.** Default port 8222 exposes server internals. Bind to localhost or internal network only. Missing `bind: "127.0.0.1"` on monitoring port = HIGH.

9. **Cluster TLS for multi-node.** Inter-node replication MUST use TLS (`cluster.tls.verify = true`). Plaintext cluster traffic = CRITICAL.

10. **JetStream persistence volume.** Docker Compose MUST mount JetStream storage dir as persistent volume (`/data/jetstream`). `tmpfs` or ephemeral volume = CRITICAL (data loss on restart).

11. **Resource limits and system account isolation.** `system_account: SYS` isolates system messages from application accounts. Without it, `$SYS.>` subjects leak into user accounts.

## Key Findings — Mosquitto (Docker)

12. **`allow_anonymous false`** mandatory in production. Default-open broker = CRITICAL.

13. **TLS mandatory; close plaintext 1883.** Only expose 8883 (TLS) to clients outside trusted network. Self-signed cert only acceptable with a private CA infrastructure; otherwise use Let's Encrypt / commercial CA.

14. **PBKDF2-SHA512 (`$7$` format) password hashes.** `mosquitto_passwd` with the `-H sha512` flag produces `$7$` hashes; older DES/MD5 = CRITICAL. Iteration count MUST be high (default 101 in old versions is obsolete; modern default is ≥ 1_000_000 but check the actual hash output prefix).

15. **Topic ACL for multi-tenancy.** `acl_file` maps users (or patterns) to allowed topics:
    ```
    user device1
    topic readwrite tenants/acme/devices/device1/#
    
    user device2
    topic readwrite tenants/acme/devices/device2/#
    
    pattern read tenants/%u/config/#
    ```
    Missing ACL enforcement allowing cross-tenant subscribe = CRITICAL.

16. **Persistent volumes for Docker deploy.** Standard Mosquitto image expects three volumes:
    ```yaml
    volumes:
      - ./mosquitto/config:/mosquitto/config:ro
      - mosquitto-data:/mosquitto/data
      - mosquitto-log:/mosquitto/log
    ```
    `/mosquitto/data` holds the retained message store and persistent subscriptions — without persistence, retained topics and QoS 1/2 message state are lost on container restart = HIGH.

17. **Health check in Docker Compose.** Mosquitto image doesn't ship curl/wget; the simplest health check uses `mosquitto_sub` with `-E` (exit after ack) or a plain TCP connect check:
    ```yaml
    healthcheck:
      test: ["CMD-SHELL", "mosquitto_sub -h localhost -p 1883 -t '$$SYS/#' -C 1 -W 3 || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    ```
    For TLS-only: test against the TLS port with cert verification. Missing healthcheck = MEDIUM.

18. **`persistence true` + `autosave_interval`.** Enables retained message + subscription persistence. Set `autosave_interval 60` for 1-minute flushes. Missing = HIGH.

19. **Connection limits and rate limits.** `max_connections`, `max_inflight_messages`, `message_size_limit`. Unbounded = DoS risk.

20. **Bridge mode / HA.** Mosquitto has no native cluster; HA requires bridges between brokers or an external load balancer with shared persistence. For aqua-saas edge → cloud, a bridge pattern on the edge broker forwards tenant topics upstream.

21. **Logging configuration.** `log_dest file /mosquitto/log/mosquitto.log` + `log_type error warning notice information`. Mount the log volume for persistence. Log rotation via logrotate or `log_type information subscribe unsubscribe` with external rotation.

22. **Credentials via secrets, not baked into image.** Password file MUST be mounted from host or Docker secret, never `COPY` into the image.

## Security Concerns — NATS
- Plaintext 4222 client port exposed = CRITICAL.
- `verify: true` missing on client port (no mTLS) = CRITICAL.
- Single account for multi-tenant workloads = HIGH (subject leakage risk).
- Wildcard `>` permissions without `deny` = HIGH.
- Plaintext passwords in config (not bcrypt) = CRITICAL.
- Monitoring port 8222 bound to 0.0.0.0 = HIGH.
- Cluster / leafnode without TLS = CRITICAL.
- JetStream storage on non-persistent volume = CRITICAL.
- Missing per-account JetStream quotas = HIGH.
- Missing `system_account` declaration = MEDIUM.

## Security Concerns — Mosquitto
- `allow_anonymous true` = CRITICAL.
- Plaintext port 1883 exposed externally = CRITICAL.
- Password file with old DES/MD5 hashes = CRITICAL.
- PBKDF2 iterations too low = HIGH.
- Missing or permissive `acl_file` = CRITICAL.
- Credentials / password file baked into Docker image = CRITICAL.
- Missing persistent volume on `/mosquitto/data` = HIGH.
- Missing healthcheck = MEDIUM.
- `persistence false` in production = HIGH.
- Log volume not mounted = MEDIUM (logs lost on restart).
- No connection / message rate limits = HIGH.

## Architectural Implications for infra-expert reviews
- Any NATS client port without TLS + `verify: true` = CRITICAL.
- Any NATS deployment using a single account for multiple tenants = HIGH.
- Any NATS user permission without explicit allow scoping = HIGH.
- NATS JetStream storage on non-persistent volume = CRITICAL.
- Mosquitto with `allow_anonymous true` or plaintext 1883 exposed externally = CRITICAL.
- Mosquitto password file with non-PBKDF2 hashes = CRITICAL.
- Missing ACL enforcement (cross-tenant leakage possible) = CRITICAL.
- Missing persistent volumes on broker data directories = CRITICAL/HIGH.
- Missing healthchecks in Docker Compose for brokers = MEDIUM.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → Docker (Critical)` → new subsection **NATS / Mosquitto**:

**NATS JetStream:**
- Client port MUST use TLS with `verify: true` (mTLS); plaintext or no verify = CRITICAL.
- Multi-tenant workloads MUST use distinct NATS accounts with isolated subject namespaces; single account = HIGH.
- User permissions MUST use explicit `allow` lists with principle of least privilege; wildcard-without-deny = HIGH.
- Passwords MUST be bcrypt-hashed (`$2a$`), never plaintext in config; plaintext = CRITICAL.
- Monitoring port MUST bind to internal/localhost only; `0.0.0.0` = HIGH.
- Cluster and leafnode ports MUST use TLS; plaintext = CRITICAL.
- JetStream storage MUST be on a persistent volume; ephemeral = CRITICAL.
- Each account MUST declare JetStream quotas (`max_mem`, `max_file`, `max_streams`); missing = HIGH.
- `system_account` MUST be declared to isolate `$SYS` traffic from app accounts.

**Mosquitto:**
- `allow_anonymous false` MUST be set in production; anonymous = CRITICAL.
- Plaintext port 1883 MUST be closed to external networks; exposed = CRITICAL.
- Password file MUST use `$7$` PBKDF2-SHA512 with high iteration count; older hashes = CRITICAL.
- `acl_file` MUST enforce per-user/per-tenant topic restrictions; missing = CRITICAL.
- `/mosquitto/data` MUST be mounted as a persistent volume; missing = HIGH.
- Docker healthcheck MUST probe the broker (e.g., `mosquitto_sub $SYS/# -C 1`); missing = MEDIUM.
- `persistence true` and `autosave_interval` MUST be set; missing = HIGH.
- `max_connections`, `max_inflight_messages`, `message_size_limit` MUST be set; unbounded = HIGH.
- Credentials MUST come from mounted secrets, NEVER baked into the image; baked = CRITICAL.
- Log volume MUST be mounted for audit persistence; missing = MEDIUM.
