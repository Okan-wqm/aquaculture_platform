# Farm Event Catalog Parity

## SSOT

The event catalog is the source of truth for event type, version, producer, consumer, schema reference, and bridge compatibility. Code, schemas, and docs must move together.

## Required Columns

- `eventType`
- `eventVersion`
- `producer`
- `consumerName`
- `schemaRef`
- `aggregateType`
- `tenantScoped`
- `idempotencyKeySource`
- `legacyBridgeState`
- `dlqReplaySupported`

## CI Gate

The parity gate must fail when:

- a farm business handler calls `OutboxPublisher.enqueue()` for an event absent from the catalog;
- a catalog event lacks a committed schema fixture;
- a consumer exists without an inbox idempotency entry;
- a bridge maps an event type/version not present in the catalog;
- a schema fixture changes without an explicit event version decision.

## Migration Rule

No direct publisher suppression or temporary allowlist is valid completion evidence. Migrated domains must be switched to `--mode all` guardrails before the final farm-service gate becomes blocking.
