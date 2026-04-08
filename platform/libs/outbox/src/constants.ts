/**
 * Dependency injection tokens for the @platform/outbox library.
 *
 * Each consuming service registers its own concrete outbox entity
 * (e.g. `FarmOutbox extends OutboxEntityBase`) and binds it to the
 * `OUTBOX_ENTITY_CLASS` token via `OutboxModule.forFeature(...)`.
 * Services that share a process (rare) cannot share these tokens.
 */

/** Injection token for the concrete outbox entity class. */
export const OUTBOX_ENTITY_CLASS = Symbol('OUTBOX_ENTITY_CLASS');

/** Injection token for the OutboxModule options object. */
export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');

/** Maximum number of outbox events processed per poll cycle. */
export const OUTBOX_BATCH_SIZE = 100;

/** Events with retryCount >= this threshold are dead-lettered. */
export const OUTBOX_MAX_RETRIES = 5;

/** Truncate `lastError` text to this many characters before persisting. */
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 2000;

/**
 * UUID v4 validation regex — defined locally rather than imported from
 * `@aquaculture/backend-common` so the outbox library stays at a lower
 * dependency level and can be consumed by any service without pulling
 * in the NestJS-specific infrastructure package.
 *
 * Enforced at `OutboxPublisher.enqueue` because `event.tenantId` becomes
 * a NATS subject segment (`events.{tenantId}.{eventType}`) downstream,
 * and subsequently a Socket.IO room key (`tenant:{tenantId}`). A
 * malformed tenantId could inject subject wildcards (`*`, `>`) into NATS
 * routing, poison structured logs via newline injection, or collide with
 * another tenant's room key. Failing closed at the publisher boundary
 * keeps all downstream layers honest.
 */
export const OUTBOX_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PascalCase validation regex for `eventType`. The event type becomes the
 * third NATS subject segment (`events.{tenantId}.{eventType}`). Restricting
 * it to `^[A-Z][A-Za-z0-9]+$` prevents subject wildcards, dot injection,
 * and unexpected characters leaking into metric labels / room names.
 */
export const OUTBOX_EVENT_TYPE_REGEX = /^[A-Z][A-Za-z0-9]+$/;
