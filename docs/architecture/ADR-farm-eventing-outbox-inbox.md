# ADR: Farm Eventing Outbox And Inbox

## Status

Accepted.

## Decision

Farm-service writes business-significant events through a transactional outbox. Direct `eventBus.publish` from business write paths is not accepted. Consumers must use durable inbox idempotency before side effects.

## Event Envelope

Events use this envelope shape:

- `eventId`
- `eventType`
- `eventVersion`
- `source`
- `subject`
- `occurredAt`
- `tenantId`
- `aggregateId`
- `aggregateType`
- `correlationId`
- `causationId`
- `traceId`
- `schemaRef`
- `data`

## Publish Policy

The outbox relay is the only publisher. A message is published after the broker acknowledges it. Duplicate relay attempts must not create duplicate downstream effects.

## Consumer Policy

- Duplicate inbox record: no-op and ack.
- Transient failure: retry with bounded backoff.
- Business rejection: ack with durable reason.
- Poison message: DLQ with replay instructions.
