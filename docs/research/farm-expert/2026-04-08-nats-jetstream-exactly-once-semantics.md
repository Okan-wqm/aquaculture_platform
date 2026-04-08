# Research: NATS JetStream Exactly-Once Delivery + Outbox Integration

**Topic:** How to achieve exactly-once semantics in NATS JetStream, and how to combine JetStream with Postgres outbox for end-to-end reliability.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [NATS JetStream overview (NATS docs)](https://docs.nats.io/nats-concepts/jetstream)
- [JetStream Model Deep Dive (NATS docs)](https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive)
- [JetStream Consumers (NATS docs)](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [jetstream-outbox — Postgres + JetStream outbox (GitHub)](https://github.com/cms103/jetstream-outbox)
- [NATS JetStream Playbook: Exactly-Once, Minus the Bloat (Medium)](https://medium.com/@hadiyolworld007/nats-jetstream-playbook-exactly-once-minus-the-bloat-02fd9d5a051c)
- [NATS JetStream Persistence (OneUptime, Jan 2026)](https://oneuptime.com/blog/post/2026-01-26-nats-jetstream-persistence/view)

## Key Findings

1. **JetStream provides exactly-once semantics only when BOTH sides cooperate:** publisher deduplication via `Nats-Msg-Id` header AND consumer double-ack. Neither alone is sufficient.
2. **Publisher dedup:** every published message gets a unique `Nats-Msg-Id` (typically the domain event ID or outbox row ID). JetStream tracks these IDs within a configurable rolling window; duplicates are silently acknowledged without storing. The window is per-stream and is NOT persisted across server restarts unless JetStream is configured for persistent dedup state.
3. **Consumer double-ack:** after processing, the consumer sends `ack` and waits for a server-side `ack-of-ack`. Without double-ack, a crash between ack and server confirmation causes redelivery.
4. **Durable consumers** persist subscription state — without `Durable` name, consumer state is ephemeral and redelivery is ambiguous after disconnect.
5. **Outbox + JetStream = full reliability.** The outbox table in Postgres ensures the event is persisted atomically with the business change (via transactional insert). A background publisher reads the outbox, publishes to JetStream with `Nats-Msg-Id = outbox.id`, and on successful publish-ack marks the outbox row as published. JetStream dedup handles cases where the publisher crashed after JetStream accepted the message but before the outbox was updated.
6. **Ordering within a subject** is preserved. Ordering across subjects requires a single-subject design or explicit sequence numbers.
7. **`DeliverPolicy: New`** starts the consumer at the end of the stream. **`DeliverPolicy: All`** replays everything. **`DeliverPolicy: ByStartSequence`** lets you resume at a specific point — useful for replay after a consumer-side incident.
8. **Stream retention:** `Limits` policy retains messages until a limit is hit. `Interest` retains only while consumers exist. `WorkQueue` deletes on ack. Choose based on replayability needs.
9. **MaxDeliver** limits per-message redelivery attempts. Beyond MaxDeliver, the message moves to a DLQ (or is silently dropped if no DLQ is configured). **Missing DLQ = silent data loss on poison messages.**
10. **Consumers MUST be idempotent.** Exactly-once delivery is a broker property, not an application property. The application must deduplicate based on the message ID even with exactly-once enabled (defense in depth against broker misconfiguration or window expiry).

## Security Concerns
- **Cross-tenant event leak via shared subject** — subjects must be tenant-prefixed (e.g. `farm.tenants.{tenantId}.batch.created`) or events must carry a `tenantId` that consumers explicitly verify. Missing tenant scoping = CRITICAL.
- **Authorization on stream consumption** — JetStream consumers must be scoped by NATS account or subject permissions. Unrestricted consumer access = HIGH.
- **TLS mandatory in production** between clients and NATS cluster. Plaintext NATS = CRITICAL.
- **Dead-lettered events may contain sensitive payloads.** DLQ access must be restricted and monitored.

## Performance Concerns
- Dedup window memory scales with `MaxMsgs` and `MaxAge` on the stream. An overly large dedup window with high-cardinality IDs can exhaust server memory.
- `ack-wait` timeout: too short causes spurious redelivery, too long stalls the consumer pipeline on a crashed consumer.
- Stream sharding across NATS cluster nodes is mandatory for high-throughput subjects.
- Consumer prefetch (`MaxAckPending`) controls concurrency — too low starves the consumer, too high risks unprocessed messages on a crash.

## Architectural Implications for farm-expert reviews
- Any event publication from a command handler that goes directly to NATS (not through outbox) = CRITICAL.
- Missing `Nats-Msg-Id` header on publishes = HIGH (loses dedup safety).
- Consumer without idempotency protection at the application level = HIGH.
- Missing DLQ configuration on streams carrying critical events = HIGH.
- Subjects without tenant scoping = CRITICAL.
- Non-durable consumers for critical event flows = HIGH (state loss on disconnect).
- Missing monitoring on: stream depth, consumer lag, DLQ depth, dedup window occupancy.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules → CQRS Compliance` (merging with the outbox rule):
- Events MUST be published with `Nats-Msg-Id` header set to the outbox row ID or domain event ID for broker-level dedup. Missing header = HIGH.
- Consumers MUST use `Durable` name and `MaxAckPending` appropriate to their throughput. Non-durable consumers on critical event streams = HIGH.
- Streams carrying critical events MUST have a DLQ configured with monitoring on DLQ depth. Missing DLQ = HIGH (silent data loss).
- NATS subjects MUST be tenant-scoped (either prefixed `tenants/{tenantId}/...` or carrying `tenantId` verified by every consumer). Untenanted subjects on tenant data = CRITICAL.
- JetStream consumer permissions MUST be scoped by NATS account or subject ACL. Unrestricted consume access = HIGH.
- TLS mandatory for NATS client connections in production — plaintext = CRITICAL.
