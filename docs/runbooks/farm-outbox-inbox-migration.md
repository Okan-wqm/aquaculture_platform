# Farm Outbox/Inbox Migration Runbook

## Scope

Canonical farm event storage is `farm.outbox_events` plus `farm.inbox_messages`. The legacy table `farm.farm_outbox` remains only during rolling deploy compatibility.

## Expand

1. Create `farm.outbox_events` with every field required by the flat `BaseEvent` envelope, relay state, retry metadata, lease metadata, tenant, aggregate, and idempotency key.
2. Create `farm.inbox_messages` with unique `(consumerName, tenantId, eventId)`. Duplicate inserts are no-op acknowledgements.
3. Add DLQ storage with original envelope, failure class, failure reason, first/last failure timestamps, and replay status.
4. Add a bridge writer/reader so old and new application versions can coexist during rolling deploy.

## Bridge

1. New writers on migrated paths enqueue only through `OutboxPublisher.enqueue()` inside the business transaction. Current migrated examples are the batch status/close/delete paths plus site, PII-free site-contact metadata, department, system, non-tank equipment, sub-equipment, tank-like equipment compatibility, tank, supplier approved-site, and feeder calibration setup write paths. The migrated setup events are also registered in strict JSON schemas and gateway realtime bridge dispatch.
2. The bridge preserves unpublished, retrying, dead-lettered, leased, tenant, aggregate, correlation, causation, and idempotency fields.
3. Relay publishes from the canonical table and marks broker acknowledgement only after publish confirmation.
4. Consumers write inbox before side effects and ack duplicate deliveries without side effects.

## Contract

- Event payloads are flat `BaseEvent` objects created with `createBaseEvent()`.
- Business write paths must not call `eventBus.publish()` directly.
- Mobile command id and correlation id must flow into transaction receipt and outbox idempotency keys.

## Rollback

Rollback is app-first only while bridge mode is enabled. Do not contract/drop `farm.farm_outbox` until all production pods and workers are confirmed on canonical outbox readers and the compatibility matrix has passed old-app/new-DB and new-app/old-DB checks.

## Verification

- Pending/retry/dead-letter counts match across legacy and canonical views before cutover.
- Replayed events preserve original `eventId`, `tenantId`, `correlationId`, and `causationId`.
- Duplicate broker delivery creates exactly one inbox row and no duplicate downstream side effect.
