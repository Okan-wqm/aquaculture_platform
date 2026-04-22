# ADR-029: Rust Transactional Outbox Pattern for `sensor-ingestion`

**Status:** Proposed
**Date:** 2026-04-22
**Deciders:** platform team, sensor-service owner, SRE
**Owner:** Okan
**Related ADRs:** ADR-011 (schema ownership), ADR-014/015 (NATS identity SSoT), ADR-025 (Rust sidecar architecture)
**Related code:** `@platform/outbox` TS pattern (`platform/libs/outbox/`)
**Related plans:** `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 7-8

---

## Context (WHY)

`apps/sensor-ingestion/src/events.rs:263-272` currently logs NATS publish failures and drops the event: a transient NATS unavailability window causes silent data loss. `PostgresSink::write_tenant_batch` writes the reading to TimescaleDB in one transaction and then pushes to an in-memory `mpsc` channel feeding the publisher; a process restart while events are in the channel = permanent loss for those events.

The TS platform already solved this. `@platform/outbox` (`outbox-entity.base.ts`, `outbox-worker.service.ts`) implements the canonical Transactional Outbox pattern — event row + business row inserted in the same PG transaction, a separate worker dispatches asynchronously with retry/DLQ/backoff. `farm_outbox`, `hr_outbox`, `messaging_outbox` are already in production.

A Rust port — `crates/outbox-rs` — is needed for `sensor-ingestion`, with additional concerns the TS pattern did not answer:

- **Tenant-fairness under heavy load:** `FOR UPDATE SKIP LOCKED` alone does not guarantee a pathological tenant cannot starve dispatcher workers.
- **HA with multiple dispatcher replicas:** workers must coordinate without double-publish.
- **Retention + backpressure:** dispatched rows must be cleaned; pending backlog must be visible.

---

## Decision (WHAT)

`sensor-ingestion` writes NATS events via a Rust Transactional Outbox, `crates/outbox-rs`, designed as the blueprint for all future Rust services.

### Schema

Migration `database/migrations/modules/sensor/V016__create_event_outbox.sql` creates `sensor.event_outbox`:

```sql
CREATE TABLE sensor.event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  dispatch_attempts INT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX idx_event_outbox_pending ON sensor.event_outbox (created_at)
  WHERE dispatched_at IS NULL;
CREATE INDEX idx_event_outbox_tenant ON sensor.event_outbox (tenant_id, created_at);
```

Per ADR-011 the table lives in the owning service's schema (`sensor`), not `shared`.

### Enqueue

`PostgresSink::write_tenant_batch` enqueues the outbox row in the **same transaction** as the reading COPY. Sink TX rollback = outbox row rollback (atomicity preserved).

### Dispatcher

Single active dispatcher process per cluster (horizontal HA via `pg_try_advisory_lock('sensor_outbox_dispatcher')`; standby replicas hot). The active dispatcher:

- Claims up to 500 pending rows every 250ms with `SELECT ... FOR UPDATE SKIP LOCKED`, ordered by `created_at`.
- Claim filter includes exponential backoff: `dispatch_attempts = 0 OR last_attempted_at < NOW() - INTERVAL '100 ms' * power(2, LEAST(dispatch_attempts, 10))`.
- Publishes the batch to NATS via `futures::stream::iter(claimed).map(publish).buffer_unordered(20)` — 20-way publish parallelism. Tenant-fair-by-default because claim order is `created_at` not partitioned.
- On success: `mark_dispatched(id)` sets `dispatched_at = NOW()`.
- On failure: `mark_failed(id, error_message)`, `dispatch_attempts++`, `last_attempted_at = NOW()`.
- At `dispatch_attempts >= 10`: row stays in outbox (operator review); counter `sensor_ingestion_outbox_dlq_total{tenant_bucket}` increments.

### Retention + Backpressure

- `OutboxMaintenance::cleanup_published` runs nightly (`0 3 * * *` via `tokio_cron_scheduler`): `DELETE FROM sensor.event_outbox WHERE dispatched_at < NOW() - INTERVAL '7 days'`.
- `OutboxMaintenance::pending_gauge` every 30s: `metrics::gauge!("sensor_ingestion_outbox_pending", count)`.
- Prometheus alert `sensor_ingestion_outbox_pending > 100000 for 10m` → pager.
- DLQ rows (`dispatch_attempts >= 10`) NOT auto-deleted; `docs/runbooks/outbox-dlq-review.md` describes the operator workflow.

### At-least-once semantics

Consumers must be idempotent (alert-engine, AI service already de-dupe by `eventId`). Duplicate delivery after a dispatcher crash is accepted.

---

## Consequences

**Positive:**
- No silent event drop on transient NATS failure.
- Durable backlog visibility via `sensor_ingestion_outbox_pending` gauge.
- Atomic emit: a reading that lands in TimescaleDB is guaranteed to be dispatched at-least-once.
- Rust port reusable by future Rust services — Faz 4 adoption trivial.

**Negative:**
- One extra table write per batch flush (small; same PG transaction, no additional round-trip).
- Retention policy requires operator attention when pending backlog grows — not a black box.
- Advisory-lock coordination means exactly one dispatcher is live; standby is warm but idle — compute cost.

**Neutral:**
- Tenant-fair scheduling is emergent from `created_at` ordering; no explicit partition key is introduced. If a hot tenant saturates the 20-way publish pool, fairness degrades — tracked by `sensor_ingestion_outbox_pending_by_tenant_bucket` histogram; partition sharding is the Faz 4 escape hatch.

---

## Alternatives Considered

1. **NATS JetStream durable consumer** — rejected. ADR-014/015 positions NATS core (mTLS cert-only) as SSoT; JetStream stream durability adds operational surface (storage tier, retention, replica config) that sensor-ingestion doesn't need.
2. **Partition-hash multi-worker** (every worker owns `tenant_id % N`) — rejected for Faz 2 because a single-dispatcher + 20-way publish gives 40K event/sn and is simpler to reason about. Deferred to Faz 4 if scale requires it; tracked in ORPHAN register if surfaced earlier.
3. **In-memory channel with persistent WAL fallback** — rejected; reinvents PG transaction semantics already available.

---

## Verification

- `cargo test -p sensor-ingestion --test outbox_enqueue_in_same_transaction_as_persistence`
- `cargo test -p sensor-ingestion --test dispatcher_publishes_pending_events_then_marks_dispatched`
- `cargo test -p sensor-ingestion --test dispatcher_retries_transient_failure_with_backoff`
- `cargo test -p sensor-ingestion --test dispatcher_marks_dlq_after_max_attempts`
- `cargo test -p sensor-ingestion --test tenant_a_stuck_events_do_not_block_tenant_b_dispatch`
- `cargo test -p sensor-ingestion --test outbox_tenant_fair_scheduling`
- `cargo test -p sensor-ingestion --test outbox_maintenance_cleanup`
- Migration rollback: `V016__create_event_outbox.down.sql` drops the table (safe only when `pending_count = 0`).
