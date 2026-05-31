# Event Store And Outbox SSOT

This branch aligns event persistence, projections, and outbox dispatch around one ordering model.

## Event Store

- Stored events have a global `sequence`.
- Tenant aggregate streams enforce uniqueness with tenant, aggregate type, aggregate id, and version.
- Projection inbox rows are keyed by tenant, projection name, and event id, so replay is idempotent.
- Projection handlers run inside the same transaction as inbox/checkpoint updates.
- Retry sleeps happen outside the transaction. Each retry opens a fresh transaction and either commits the handler plus checkpoint or rolls back all side effects.

## TypeScript Outbox

- Every outbox table has a monotonic `sequence`.
- `OutboxPublisher.enqueue()` uses `options.aggregateId` when supplied, otherwise `event.aggregateId`.
- Malformed aggregate ids are rejected before persistence because per-aggregate FIFO depends on that key.
- Sequence migrations set the default before backfill, so concurrent inserts cannot create `NULL` sequence values.
- Messaging wires its sequence migration into the app migration list.

## Rust Sensor Outbox

- `sensor.event_outbox` is source-scoped infrastructure in the `sensor` schema.
- Claiming is an atomic `UPDATE ... RETURNING` with `claimed_at` and `claimed_by`.
- A claimed row is skipped until the five-minute lease expires.
- `mark_dispatched` and `mark_failed` clear the lease.
- Rust publishes `Nats-Msg-Id: <outbox-row-id>`, so JetStream duplicate detection can collapse dispatcher retries.

## Invariants

- Event ordering key: global sequence for projections, outbox sequence for transport.
- Tenant isolation key: tenant id appears in stored events, projection inbox, outbox rows, and NATS subjects.
- Idempotency key: projection inbox for handlers, outbox row id for NATS publish dedupe.
