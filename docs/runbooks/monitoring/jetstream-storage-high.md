# Runbook — JetStreamStorageHigh

**Alert:** `JetStreamStorageHigh` (warning) · **Rule:**
`infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`

**Meaning.** `nats_server_jetstream_total_storage_bytes` exceeded 75% of the configured
`max_file_store` (threshold 7.5GiB against the 10GiB in `infrastructure/docker/nats/nats.conf`)
for 15 minutes.

**First actions:**

1. `curl -s http://localhost:8222/jsz | head -c 2000` (or
   `docker exec aqua-nats wget -qO- http://localhost:8222/jsz`) — confirm `store.total` bytes and
   per-stream breakdown.
2. Which stream owns the bytes? `AQUACULTURE_TELEMETRY` (`telemetry.>`, 6GiB cap, Discard New) is
   the 60-minute outage buffer — a full telemetry stream means the sidecar/edge backpressure is
   engaged as designed; `AQUACULTURE_EVENTS` (`events.>`, 1.5GiB cap, Discard Old) full means
   consumer backpressure: check which durable consumer stopped acking (`/jsz?consumers=true`).
3. Disk-level check: `scripts/deploy/droplet-capacity.sh report` — the broker gate lines
   (`nats_max_file_store_bytes`, `broker_queue_budget_bytes`) plus the general disk snapshot.

**Likely causes:** a stalled consumer (acks stopped → Limits retention never releases), a
message-size drift beyond the measured 600–750B, or a stream budget raised in the event bus
without raising `max_file_store` and the threshold together (the invariant
`tests/invariants/nats-jetstream-store-budget.spec.ts` fails that change at review time).

**Escalation:** if the store keeps growing toward the cap, the discard policy decides what survives
— on the events stream that is silent oldest-loss for domain events. Escalate to the platform owner
before eviction begins; resize the volume or fix the stalled consumer.
