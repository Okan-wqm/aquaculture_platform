# Runbook — NatsExporterDown

**Alert:** `NatsExporterDown` (critical) · **Rule:** `infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`

**Meaning.** The `nats-exporter` scrape (`aqua-nats-exporter:7777`) has returned `up == 0` for more than 1 minute. JetStream visibility (storage, streams, consumers) is blind; `JetStreamStorageHigh` can no longer fire while this is down.

**First actions:**

1. `docker ps -a | grep aqua-nats-exporter` — is the container running/restarting?
2. `docker logs aqua-nats-exporter --tail 50` — the exporter logs the NATS monitoring URL it polls; connection refused means the NATS container or its 8222 endpoint is down (`docker exec aqua-nats wget -qO- http://localhost:8222/healthz`).
3. If NATS itself is down, that is the incident — telemetry ingestion and the event bus are stopped; follow the NATS restart ordering in the 100-tenant readiness plan Task 2 rollout (publishers stopped, stream verified via /jsz after restart).

**Likely causes:** NATS container down (the real incident), exporter crash-loop (image/resource limits — 64M cap), or docker network partition between the exporter and `aqua-internal`.

**Escalation:** if NATS is down, page the platform owner — the 60-minute outage buffer is now burning.
