# Research: Event Store Immutability, Optimistic Concurrency, Projections & Snapshots

**Topic:** StoredEvent append-only guarantee, expectedVersion optimistic concurrency, PostgreSQL sequence global ordering semantics, snapshot-based read optimization, projection checkpoints and idempotent replay
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [Martin Fowler - Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Martin Fowler - Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html)
- [Martin Fowler - CQRS](https://martinfowler.com/bliki/CQRS.html)
- [Microsoft Learn - Event Sourcing Pattern (Azure Architecture Center)](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Microsoft Learn - CQRS Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
- [Microsoft Learn - Azure Cosmos DB design pattern: Event sourcing](https://learn.microsoft.com/en-us/samples/azure-samples/cosmos-db-design-patterns/event-sourcing/)
- [PostgreSQL 18 - CREATE SEQUENCE](https://www.postgresql.org/docs/current/sql-createsequence.html)
- [PostgreSQL 18 - Sequence Manipulation Functions (9.17)](https://www.postgresql.org/docs/current/functions-sequence.html)
- [PostgreSQL 18 - Transaction Isolation (13.2)](https://www.postgresql.org/docs/current/transaction-iso.html)

## Key Findings

1. **Events are IMMUTABLE — the event store is append-only.** An event records something that happened in the past; mutating it is historical revisionism. The database schema must enforce this with a trigger or policy: `REVOKE UPDATE, DELETE ON stored_event FROM ALL`. The only allowed operations are `INSERT` (append) and `SELECT` (read). Per Martin Fowler: "an event's source data is immutable — it's what we know of what happened, and we can't easily change it."
2. **Optimistic concurrency via `expectedVersion`.** To prevent lost updates when two command handlers race to append to the same aggregate stream, the append operation carries an `expectedVersion` — the highest version the caller has seen. The event store rejects the append if the current stream head is different. Per Microsoft Learn: "Event stores address concurrent update scenarios by using optimistic concurrency control and reject an append if the stream changed since it was read. Upon rejection, the handler reloads the entity, reevaluates, and retries."
3. **Implementation in PostgreSQL** — the canonical pattern is a UNIQUE constraint on `(stream_id, version)` where `version` is a per-stream monotonic integer. The append query is:
   ```
   INSERT INTO stored_event (stream_id, version, event_type, payload, metadata, global_position)
   VALUES ($1, $2, $3, $4, $5, nextval('event_global_seq'))
   ```
   If two transactions try to insert the same `(stream_id, version)`, the second hits a unique-violation (`23505`) and the handler retries. No explicit lock needed — PostgreSQL's MVCC + unique index does the work.
4. **`global_position` via PostgreSQL sequence — NOT gapless.** Per PostgreSQL docs: "PostgreSQL sequence objects cannot be used if 'gapless' assignment of sequence numbers is needed because nextval and setval calls are never rolled back." A transaction that reserves `global_position = 42` and then rolls back leaves a permanent gap. **This is acceptable for event sourcing** — projections should consume by `global_position` ASC but must tolerate gaps. A stuck projection waiting for "42" forever after a rollback is a hang bug.
5. **Ordering guarantee strength.** PostgreSQL sequences are *not* guaranteed to be monotonic across concurrent transactions due to caching and commit ordering — a transaction that acquired sequence value 100 may commit *after* a transaction that acquired 101. This means a projection consumer polling by `global_position > checkpoint` can miss events if it reads while a transaction holding a lower sequence value is still in-flight. The fix is the **gapless tail window**: the consumer reads `WHERE global_position > checkpoint AND global_position <= (SELECT MAX(global_position) FROM stored_event WHERE committed_at < now() - '1 second'::interval)`. The 1-second grace window lets in-flight transactions commit or roll back before the consumer advances. PostgreSQL's `pg_current_xact_id()` + `txid_snapshot_xmin()` provide an alternative: consume only events whose originating transaction ID is below the current snapshot's `xmin`.
6. **Cosmos DB / SQL Server alternative** — use a strictly monotonic column via `IDENTITY` with `SERIALIZABLE` isolation, or a gapless sequence via an explicit counter table locked with `SELECT ... FOR UPDATE`. The performance cost is significant (single point of contention) but yields true global ordering.
7. **Snapshots are a read optimization, not a source of truth.** Per Microsoft Learn: "Snapshots are an optimization, not a replacement for the event stream. The event stream remains the source of truth, and you can regenerate snapshots from it at any time." A `Snapshot` entity stores the aggregate state at version N; loading an aggregate reads the latest snapshot and replays events from N+1 forward. Snapshots must be regenerable — if the snapshot is corrupt or lost, the system must still function by replaying from the beginning.
8. **Snapshot invalidation.** When the aggregate's state model changes (field added, computation changed), old snapshots are invalid. The solution is a `snapshotSchemaVersion` column — loader checks version match and falls back to full replay if mismatch. Stale snapshots are lazily discarded.
9. **Projection checkpoints and idempotent replay.** Each projection (e.g., the read model that powers "list my invoices") tracks its own `ProjectionCheckpoint` — the `global_position` of the last event it processed. On restart, it resumes from the checkpoint. The projection handler must be **idempotent** — re-applying the same event must not corrupt the read model. The canonical pattern is `INSERT ... ON CONFLICT DO UPDATE` keyed on the aggregate ID, or a "max-seen-event-id" check inside the projection state.
10. **Projection catch-up vs live tail.** Two modes:
    - **Catch-up:** read a batch of events from the checkpoint forward (`LIMIT 1000`), apply all, advance checkpoint, commit. Loop until caught up.
    - **Live tail:** after catch-up, subscribe to a PostgreSQL `LISTEN/NOTIFY` channel triggered on `stored_event` insert, wake up, read new events.
    The transition from catch-up to live-tail must not drop events — the live-tail subscription should start *before* the final catch-up batch, and the final batch must fetch `WHERE global_position > checkpoint` atomically.
11. **Adaptive backoff for stuck projections.** If the projection handler throws (e.g., read model DB is down), don't tight-loop retry — exponential backoff from 100ms to 60s, then alert. A projection that's been stuck for > 5 minutes emits a Prometheus alert `projection_lag_seconds > 300`.
12. **Event schema evolution.** Events are immutable, but the code that reads them evolves. Two patterns:
    - **Upcasting:** on read, transform old event versions to the current schema (`StoredEvent` carries a `schemaVersion`). The DB stays untouched; the upcaster is a pure function chain.
    - **Copy-and-transform migration:** emit a new event type for new data and deprecate the old type. The old events remain valid; the projection handles both.
    Never mutate historical events to "fix" their schema.
13. **Multi-tenancy in event store.** Each event row carries `tenant_id`. Streams are scoped by `(tenant_id, stream_id)` — the UNIQUE constraint for optimistic concurrency is `(tenant_id, stream_id, version)`. Projections are scoped per tenant (one checkpoint per tenant, or a single checkpoint with tenant filtering in the query). Cross-tenant event leakage is a CRITICAL security failure.

## Security Concerns

- **CRITICAL:** Any `UPDATE` or `DELETE` path on `stored_event` table. Event store immutability must be enforced by DB privilege (`REVOKE UPDATE, DELETE`), not by convention. A rogue migration that adds "UPDATE stored_event SET payload = ..." is unauditable revisionism.
- **CRITICAL:** Missing `expectedVersion` check on append — two concurrent commands both succeed, both appear as version N, last write wins on projection → split-brain aggregate state.
- **CRITICAL:** A projection that polls by `global_position > checkpoint` without the "safe tail window" (1-second grace or `xmin` filter) silently skips events whose writer transaction commits out-of-order. This is a data-loss bug that surfaces as missing rows in read models.
- **CRITICAL:** Cross-tenant event queries — a projection handler that forgets `WHERE tenant_id = $1` leaks events across tenants.
- **HIGH:** Snapshot treated as source of truth (no fallback-to-replay). A corrupt snapshot row permanently corrupts the aggregate.
- **HIGH:** Event payload contains unencrypted PII (email, phone, physical address) with multi-year retention. GDPR right-to-erasure is impossible on an append-only store without crypto-shredding: encrypt PII with a per-subject key, "delete" by destroying the key. Plan for this at schema design time.
- **HIGH:** Projection handler not idempotent — on replay after crash, double-writes corrupt read models.
- **MEDIUM:** Projection checkpoint stored in the same database as the read model but updated in a separate transaction from the read model write — crash between the two yields a "phantom" replay.
- **MEDIUM:** No alert on projection lag. Consumers of the read model see stale data indefinitely.

## Performance Concerns

- `global_position` sequence is a single point of contention at extremely high write rates (>50K events/sec). For such rates, a partitioned sequence per tenant or a hybrid logical clock (HLC) is appropriate. At aqua-saas scale, a single sequence is fine.
- Append contention on the same stream: if a single aggregate receives hundreds of writes/sec, the optimistic-concurrency retry loop dominates. The architectural answer is *don't design hot-spot aggregates* — partition the domain into smaller aggregates.
- Large event payloads (>4KB) slow append and inflate storage. Keep events small; store blob references (S3) for large data, not inline.
- Snapshot generation strategy: snapshot every N events (e.g., every 100). Snapshot too rarely → long replay; snapshot too often → wasted I/O.
- Read model projection lag is the primary user-visible "is my action reflected in the UI" metric. Target p99 lag < 500ms.

## Architectural Implications for platform-services reviews

- The `stored_event` table in `apps/event-store-service/src/event-store/entities/stored-event.entity.ts` must have:
  - `UNIQUE (tenant_id, stream_id, version)` — optimistic concurrency
  - `global_position BIGINT NOT NULL DEFAULT nextval('event_global_seq')` — cross-stream ordering
  - `committed_at TIMESTAMPTZ NOT NULL DEFAULT now()` — for the safe-tail window
  - `schema_version INT NOT NULL DEFAULT 1` — upcasting support
  - `tenant_id` NOT NULL — multi-tenant isolation
  - DB-level `REVOKE UPDATE, DELETE` or a BEFORE UPDATE/DELETE trigger raising an exception
  - Index `(tenant_id, stream_id, version)` for per-stream reads
  - Index `(global_position)` for projection catch-up
- The append method must accept `expectedVersion: number` and translate `23505` unique-violation to a `ConcurrencyConflictError` the command handler can retry.
- Projections implement a `BaseProjection` with:
  - `checkpoint: bigint` read from `projection_checkpoint` table
  - `handleBatch(events: StoredEvent[]): Promise<void>` called with batches
  - A transaction wrapping (a) apply events, (b) advance checkpoint — committed atomically in the read model DB
  - Adaptive backoff 100ms → 60s on handler failure
  - Prometheus gauge `projection_lag_seconds = now() - max(events.committed_at processed)`
- The safe-tail window query pattern: `WHERE global_position > $checkpoint AND committed_at < now() - '1 second'::interval ORDER BY global_position ASC LIMIT $batchSize`.
- Snapshot entity carries `aggregate_id`, `aggregate_type`, `version`, `schema_version`, `state JSONB`, `created_at`. Loader reads latest snapshot with matching `schema_version` and replays events `WHERE stream_id = $1 AND version > $snapshot.version`.
- A Domain Event Upcaster chain is mandatory if any event type has undergone a schema change. Unit tests load fixture payloads at every historical schema version and assert the upcaster produces the current shape.
- Integration test: two concurrent `appendEvents({ expectedVersion: 5 })` calls, one succeeds, the other receives `ConcurrencyConflictError`. Retried with `expectedVersion: 6`, it succeeds.
- Integration test: crash a projection mid-batch, restart, assert no double-application by checking a uniqueness invariant on the read model.
- Integration test: try `UPDATE stored_event SET payload = '...'` from inside a migration — assert the operation fails with an explicit error.

## Domain Rule Additions for platform-services (Event Store Integrity subsection)

- **[CRITICAL]** `stored_event` table MUST enforce append-only via DB-level `REVOKE UPDATE, DELETE` or a trigger. Application-level convention is insufficient. Any migration that UPDATEs or DELETEs a stored event is a blocking review failure.
- **[CRITICAL]** Every append operation MUST carry `expectedVersion` and MUST translate unique-violation on `(tenant_id, stream_id, version)` into a `ConcurrencyConflictError` that the command handler retries. Appending without version check is a blocking review failure.
- **[CRITICAL]** Projection consumers MUST use the safe-tail window (grace period on `committed_at` OR `xmin`-based filtering) to avoid out-of-order-commit event skip. A naive `global_position > checkpoint` query is a blocking review failure.
- **[CRITICAL]** Every `stored_event` query in projection handlers MUST include `WHERE tenant_id = $1`. Cross-tenant leakage is a blocking review failure.
- **[CRITICAL]** Projection apply + checkpoint advance MUST happen in a single DB transaction on the read model side. Split transactions cause phantom replay or phantom skip.
- **[HIGH]** Snapshot loader MUST fall back to full replay if the stored snapshot's `schema_version` does not match the current aggregate schema. Trusting a stale snapshot as source of truth is a HIGH finding.
- **[HIGH]** PII fields in event payloads MUST be crypto-shredding-capable — encrypted with a per-subject key stored separately. A plaintext email/phone in an immutable event store is a GDPR right-to-erasure blocker.
- **[HIGH]** Projection handlers MUST be idempotent. Re-applying the same event must not change the read model. Test with a deliberate double-application.
- **[MEDIUM]** Projection lag MUST be exposed as a Prometheus metric with alert threshold at `> 300s` (tunable per projection). Silent stale projections are user-visible bugs.
- **[MEDIUM]** Snapshot strategy (every-N-events) and N value MUST be documented per aggregate. Default N = 100; aggregates with rare writes may skip snapshots entirely.
- **[MEDIUM]** Event upcasting chain MUST be pure functions with unit tests loading historical-schema fixtures. No in-place DB upgrades.

Research: `docs/research/platform-services/2026-04-08-event-store-immutability-optimistic-concurrency.md`
