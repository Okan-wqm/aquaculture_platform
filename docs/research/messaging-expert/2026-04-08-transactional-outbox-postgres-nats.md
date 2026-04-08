# Research: Transactional Outbox with PostgreSQL + NATS JetStream

**Topic:** Outbox table design, poller loop, DLQ, idempotency, intra-channel ordering, atomicity with aggregate write
**Date:** 2026-04-08
**Agent:** messaging-expert

## Sources

- [Pattern: Transactional Outbox - microservices.io (Chris Richardson)](https://microservices.io/patterns/data/transactional-outbox.html)
- [JetStream Model Deep Dive - NATS Docs](https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive)
- [Streams - NATS Docs (Duplicate Window / Nats-Msg-Id)](https://docs.nats.io/nats-concepts/jetstream/streams)
- [Headers - NATS Docs](https://docs.nats.io/nats-concepts/jetstream/headers)
- [Infinite message deduplication in JetStream - NATS Blog](https://nats.io/blog/new-per-subject-discard-policy/)
- [Implementing the Outbox Pattern - Milan Jovanovic](https://www.milanjovanovic.tech/blog/implementing-the-outbox-pattern)
- [Outbox, Inbox patterns and delivery guarantees - event-driven.io (Oskar Dudycz)](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/)
- [Revisiting the Outbox Pattern - Decodable](https://www.decodable.co/blog/revisiting-the-outbox-pattern)

## Key Findings

### 1. Atomicity with aggregate write
- The core invariant of the outbox pattern: the domain state change (message INSERT, channel mutation) and the event record (outbox INSERT) MUST be committed in the same local DB transaction. No second network call (NATS publish) may be attempted while the transaction is open. Any "try to publish, then write" variation reintroduces dual-write inconsistency and is not the outbox pattern.
- The outbox row is the durable source of truth for "an event that must eventually leave this service." If the DB crashes between transaction commit and broker publish, recovery is automatic because the outbox row survives.
- Partial commits are impossible: either both the aggregate row and the outbox row are persisted together, or neither is. This is the only property that makes the pattern safe under broker outage.

### 2. Outbox table design
A production outbox schema typically includes:
- `id` (UUID v7 or BIGSERIAL) — stable publisher-visible ID, used as `Nats-Msg-Id`.
- `aggregate_type` / `aggregate_id` — for partition routing and debugging.
- `event_type` — PascalCase (`MessageSent`, `MessageEdited`) matching the `eventType` field of `BaseEvent`.
- `payload` (JSONB) — the fully serialized `BaseEvent`-compliant object.
- `tenant_id` — every row MUST carry tenant for multi-tenant isolation and partition-key routing.
- `status` (`PENDING` | `PUBLISHED` | `DEAD_LETTERED`).
- `retry_count` INT default 0.
- `next_attempt_at` TIMESTAMPTZ for backoff scheduling.
- `last_error` TEXT for observability.
- `created_at` TIMESTAMPTZ NOT NULL — drives `ORDER BY` in the poller.
- `published_at` TIMESTAMPTZ NULL — set on success, used for cleanup retention.
- Partial index: `WHERE status = 'PENDING'` keeps the poller hot-path scan tiny as the table grows.
- Composite index `(tenant_id, aggregate_id, created_at)` to support intra-aggregate ordering.

### 3. Poller loop
- Cron/interval worker (commonly 250ms - 2s) executes `SELECT ... FOR UPDATE SKIP LOCKED LIMIT batch_size` to safely run multiple concurrent pollers without double-processing.
- `SKIP LOCKED` is mandatory: without it, contention between poller replicas causes serialization bottlenecks and head-of-line blocking.
- Typical loop: read batch (ORDER BY `created_at` ASC) -> publish to NATS with `Nats-Msg-Id = outbox.id` -> on ack update `status='PUBLISHED', published_at=now()`; on failure increment `retry_count` and set `next_attempt_at = now() + backoff(retry_count)`.
- Exponential backoff (e.g., `min(60 * 2^attempt, 600)` seconds, capped at 10 min) is standard; do NOT retry tight-loop on broker errors.

### 4. DLQ handling
- After `retry_count >= N` (commonly 5), the row is marked `DEAD_LETTERED` and emits a Prometheus metric (`outbox_dead_lettered_total{tenant, event_type}`) and a structured-log alert.
- DLQ'd rows are NEVER re-queued automatically. Human-in-the-loop required; replay is an explicit operator action.
- Poison-pill behavior: without DLQ, a single bad row blocks every subsequent event for the same partition. DLQ unblocks the flow for that key.

### 5. Idempotency (at-least-once -> effectively exactly-once)
- The outbox pattern provides at-least-once delivery. Consumers must therefore be idempotent.
- NATS JetStream supports publisher-side deduplication: setting the `Nats-Msg-Id` header causes the stream to reject duplicates within the `duplicate_window` (default 2 minutes, configurable per stream).
- This means a retry of a half-published outbox row within the duplicate window is safely deduplicated by JetStream — the publisher does not need to track ack state perfectly.
- However the duplicate window is not infinite; after expiry the same `Nats-Msg-Id` may be accepted again. Consumer-side idempotency (inbox table or Redis SET NX with TTL scoped to tenant) is still mandatory.

### 6. Ordering within a channel (partition)
- Global ordering is neither needed nor achievable. Ordering within a partition (aggregate, here: channel) is mandatory for chat semantics (edit must follow send).
- Poller queries by `ORDER BY created_at ASC` per partition key. Publishing to NATS must preserve this order: use subject like `messaging.channel.<channelId>.<eventType>` so JetStream consumers scoped per-channel observe strict order.
- WARNING: parallel pollers using `SKIP LOCKED` can reorder events across channels but MUST NOT reorder within the same channel. Guarantee this by hash-partitioning poller work by `channel_id` (e.g., `hashtext(channel_id) % N = worker_index`) OR by taking a `FOR UPDATE` row lock on the channel row during outbox insert to serialize per-channel writes.
- A subtler trap: if a single transaction writes two events (e.g., `MessageSent` + `MentionCreated`) with identical `created_at` timestamps, add a `seq BIGSERIAL` column and sort by `(created_at, seq)` to guarantee a total order per aggregate.

### 7. Broker unavailability
- Broker down: the poller keeps retrying but the DOMAIN write path is unblocked because it only touches PostgreSQL. This is the pattern's core value.
- Outbox backlog metric (`outbox_pending_total` gauge) must be alertable — a growing backlog is the earliest signal of NATS outage or schema drift.
- Outbox cleanup: `PUBLISHED` rows older than N days (7 typical) are deleted by a separate retention job to keep the table small.

## Security Concerns

- **Tenant leakage via shared outbox table:** if `tenant_id` is missing from the row, a misconfigured consumer could publish events that cause a cross-tenant fanout. Every outbox INSERT must carry `tenant_id` NOT NULL, and the poller must include it in NATS subject or headers.
- **Payload tampering at rest:** outbox rows contain PII (message bodies, user IDs). They live in Postgres and are subject to the same encryption-at-rest requirements as source tables. Retention of `PUBLISHED` rows beyond cleanup window needlessly expands the PII footprint.
- **Replay attacks on DLQ:** manual replay of DLQ'd events must be gated on TENANT_ADMIN role and audit-logged to `ComplianceAuditLog`.
- **Nats-Msg-Id reuse collision:** if outbox ID is not UUID and the application regenerates IDs after crash, duplicate events may bypass JetStream dedup. UUID v4/v7 is mandatory; integer sequences are unsafe across replicas.
- **Payload contains secrets:** never place raw passwords, API keys, or bearer tokens in outbox payload. Use reference IDs instead (`userId` not full user object).

## Performance Concerns

- **Hot partial index on PENDING rows:** critical. Without it, the poller scans millions of PUBLISHED rows for each iteration.
- **Backlog blowup under broker outage:** bounded-queue semantics are impossible (cannot reject domain writes because broker is down). Set a `outbox_backlog_age_seconds` alert threshold (e.g., 5 minutes).
- **Poller lock contention:** use `FOR UPDATE SKIP LOCKED` — avoids serialization between poller replicas.
- **Batch size tuning:** too small = high Postgres round-trip overhead; too large = long transactions holding locks. 100-500 rows per poll iteration is typical.
- **JetStream ack overhead:** single-event publish + ack per message is fine for <10k events/sec. For higher throughput use batched publish with per-batch ack.
- **Cleanup sweeper performance:** `DELETE FROM outbox WHERE status='PUBLISHED' AND published_at < now() - interval '7 days'` must be chunked (LIMIT) to avoid long-running vacuum pressure.

## Architectural Implications for messaging-expert reviews

When reviewing messaging-service code, verify:

1. **No direct NATS publish from command handlers.** Any `natsClient.publish()` / `this.natsClient.emit()` inside a command handler, saga, or service method must be flagged CRITICAL. The only permitted publisher is `OutboxPublisherService`.
2. **Outbox INSERT and aggregate INSERT share the same `QueryRunner.manager.transaction()` block.** Two separate repository calls without an explicit transaction wrapper is CRITICAL.
3. **Poller uses `FOR UPDATE SKIP LOCKED`** — any `SELECT ... FOR UPDATE` without `SKIP LOCKED` is HIGH.
4. **`Nats-Msg-Id` header is set** to the outbox row ID on every publish — missing header is HIGH.
5. **Retry count capped and DLQ'd** — unbounded retry is CRITICAL.
6. **Prometheus gauges for backlog and DLQ** — missing observability is MEDIUM.
7. **Per-channel ordering discipline.** Parallel pollers must hash-partition by `channelId`, OR the outbox writer must hold a row lock on the channel during INSERT. Missing -> HIGH.
8. **Tenant_id NOT NULL on outbox table** — missing CRITICAL (tenant leak risk).
9. **UUID IDs, not BIGSERIAL** — BIGSERIAL with crash-recovery can collide across replicas. HIGH.
10. **Cleanup sweeper exists and is chunked** — missing or unchunked -> MEDIUM (operational risk).

## Domain Rule Additions for messaging-expert

- Outbox poller MUST use `SELECT ... FOR UPDATE SKIP LOCKED` with bounded batch size.
- Outbox row MUST carry `tenantId`, `aggregateId` (channel), `eventType`, and a monotonic `seq` secondary sort key.
- `Nats-Msg-Id` header MUST equal `outbox.id` to leverage JetStream dedup window (>= 2 minutes).
- Per-channel ordering MUST be preserved by hash-partitioning poller work on `channel_id` OR by serializing outbox writes per channel with a row lock.
- Dead-lettered events (`retry_count >= 5`) MUST be Prometheus-metric'd (`outbox_dead_lettered_total`) AND structured-log alerted. Manual replay requires TENANT_ADMIN and audit-log entry.
- Outbox table MUST have partial index on `WHERE status = 'PENDING'` and a backlog-age gauge (`outbox_backlog_age_seconds`) with a 5-minute alert threshold.
- Published rows MUST be garbage-collected by a retention sweeper (chunked DELETE, <= 7 days retention).
- Outbox payload MUST NOT contain raw secrets, passwords, or bearer tokens. Only reference IDs.
