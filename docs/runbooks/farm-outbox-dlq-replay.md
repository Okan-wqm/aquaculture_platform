# Farm Outbox DLQ Replay

## Scope

Use this runbook for farm event relay failures, poison messages, and downstream recovery.

## Triage

1. Identify event by `eventId`, `tenantId`, `aggregateId`, and `eventType`.
2. Check outbox state and broker acknowledgement state.
3. Check consumer inbox for duplicate or failed processing.
4. Classify failure as transient, business rejection, or poison message.

## Replay

1. Confirm schema version support for the consumer.
2. Requeue the DLQ message with the original event envelope.
3. Preserve `eventId`, `correlationId`, and `causationId`.
4. Monitor inbox duplicate handling and downstream side effects.

## Safety

Never edit payload data during replay. If transformation is required, publish a new compensating event with its own event ID.
