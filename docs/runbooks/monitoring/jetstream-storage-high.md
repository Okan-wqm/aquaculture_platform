# Runbook — JetStreamStorageHigh

**Alert:** `JetStreamStorageHigh` (warning) · **Rule:** `infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`

**Meaning.** `nats_server_jetstream_total_storage_bytes` exceeded 75% of the configured `max_file_store` (threshold 1.5GiB against today's 2GiB in `infrastructure/docker/nats/nats.conf`) for 15 minutes.

**First actions:**

1. `curl -s http://localhost:8222/jsz | head -c 2000` (or `docker exec aqua-nats wget -qO- http://localhost:8222/jsz`) — confirm `store.total` bytes and per-stream breakdown.
2. Which stream owns the bytes? Until Task 2 lands `AQUACULTURE_TELEMETRY`, the only stream is `AQUACULTURE_EVENTS` (`events.>`, 1.5GiB cap, Discard Old) — a full events stream means consumer backpressure: check which durable consumer stopped acking (`/jsz?consumers=true`).
3. Disk-level check: `scripts/deploy/droplet-capacity.sh report` — the broker gate lines (`nats_max_file_store_bytes`, `broker_queue_budget_bytes`) plus the general disk snapshot.

**Likely causes:** a stalled consumer (acks stopped → Limits retention never releases), a message-size drift beyond the measured 600–750B, or the Task 2 telemetry stream landing without raising `max_file_store` and the threshold together.

**Escalation:** if the store keeps growing toward the cap, the discard policy decides what survives — on the events stream that is silent oldest-loss for domain events. Escalate to the platform owner before eviction begins; resize the volume or fix the stalled consumer.
