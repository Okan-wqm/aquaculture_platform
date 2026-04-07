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
