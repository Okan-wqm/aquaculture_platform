/**
 * @module CommonSchemas
 *
 * Reusable JSON Schema fragments referenced by domain-event schemas.
 * Centralising these keeps the per-event schemas terse and prevents
 * drift on field-format rules (UUID shape, ISO timestamp, free-text
 * length caps).
 *
 * # Why JSON Schema via AJV, not Zod
 *
 * The monorepo already ships `ajv@8` + `ajv-formats@3` as direct
 * dependencies (used by `sensor-service/src/protocol/services/
 * protocol-validator.service.ts`). Picking AJV here avoids adding a
 * new runtime dependency for a single use case, reuses the platform's
 * existing validator pattern, and gives the bridge a compile-once /
 * run-many path that outperforms per-event structural walks.
 *
 * AJV also makes `additionalProperties: false` trivially enforceable
 * via a single schema option — the key property that closes the H-3
 * "unknown free-text field" XSS footgun described in the review.
 *
 * # Wire-format vs compile-time typing
 *
 * BaseEvent.timestamp is declared as `Date` in the TypeScript contract
 * but is stored as an ISO 8601 string after JSONB serialization in the
 * outbox and as the same ISO string on the NATS wire. The SCHEMA
 * therefore validates `timestamp` as `string` — the wire reality — and
 * a downstream consumer that needs `Date` must parse it. This is
 * C3 in the comprehensive review and will be fixed by a separate
 * contract change; until then the schema documents the wire truth.
 *
 * @see libs/event-contracts/src/schemas/farm-events.schema.ts
 * @see libs/event-contracts/src/schemas/validator.ts
 */

/**
 * Canonical lowercase UUID wire pattern. Mirrors the
 * `TENANT_ID_REGEX`/`UUID_REGEX` helpers in `@aquaculture/backend-common`
 * so the bridge validator and the application-layer validators share
 * one rule. Used for `tenantId`, `eventId`, `batchId`, `tankId`,
 * `farmId`, etc.
 */
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Canonical UTC instant shared by TypeScript and Rust Marine wire contracts. */
export const UTC_MILLISECOND_TIMESTAMP_PATTERN =
  '^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}Z$';

export const UTC_MILLISECOND_TIMESTAMP_SCHEMA = {
  type: 'string',
  format: 'date-time',
  pattern: UTC_MILLISECOND_TIMESTAMP_PATTERN,
} as const;

/**
 * Maximum length for free-text reason / detail / notes fields carried
 * in domain events. 500 characters is more than generous for the
 * business use case (short operator comments) and blocks an attacker
 * from using an unbounded field as an amplification or memory-DoS
 * vector on the Socket.IO → React Query cache path.
 *
 * If a legitimate use case ever needs a longer field, move the long
 * text out of the event and into a referenced document (object store,
 * database). Events are routing-layer artifacts, not document storage.
 */
export const MAX_FREE_TEXT_LENGTH = 500;

/**
 * Maximum length for short-code / enum-like string fields. Used for
 * `closeReason`, `feedingTime`, `allocationType` literals, and other
 * enumerated values where the contract expects a short string. Caps
 * the upper bound at 64 characters to prevent abuse via fields that
 * the contract accepts as "string" but that should never exceed
 * a couple of dozen characters in practice.
 */
export const MAX_SHORT_CODE_LENGTH = 64;

/**
 * JSON Schema fragment for every field that appears in `BaseEvent`.
 * Referenced by per-event schemas via object spread so the common
 * shape is declared exactly once. Every farm domain event schema
 * starts with these six fields and adds its own payload on top.
 *
 * Required set = `[eventId, eventType, timestamp, tenantId, version]`.
 * Optional fields (`aggregateId`, `aggregateType`, `correlationId`,
 * `causationId`, `userId`, `retryCount`) are validated when present
 * but not required on the wire.
 */
/**
 * AJV's `JSONSchemaType<T>` generic requires `nullable: true` on any
 * field whose TypeScript type includes `undefined` (i.e. optional
 * fields declared with `?:`). Per-event schemas that reference this
 * block via object spread therefore inherit the correct nullable
 * semantics without re-declaring the shape.
 *
 * Required fields — `eventId`, `eventType`, `timestamp`, `tenantId`,
 * `version` — carry no nullable marker because their TypeScript type
 * does NOT include `undefined`.
 */
export const BASE_EVENT_PROPERTIES = {
  eventId: { type: 'string', pattern: UUID_PATTERN } as const,
  eventType: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    pattern: '^[A-Z][A-Za-z0-9]+$',
  } as const,
  timestamp: { type: 'string', format: 'date-time' } as const,
  tenantId: { type: 'string', pattern: UUID_PATTERN } as const,
  version: { type: 'integer', minimum: 1, maximum: 1000 } as const,
  aggregateId: {
    type: 'string',
    maxLength: MAX_SHORT_CODE_LENGTH,
    nullable: true,
  } as const,
  aggregateType: {
    type: 'string',
    maxLength: MAX_SHORT_CODE_LENGTH,
    nullable: true,
  } as const,
  correlationId: {
    type: 'string',
    maxLength: MAX_SHORT_CODE_LENGTH,
    nullable: true,
  } as const,
  causationId: {
    type: 'string',
    maxLength: MAX_SHORT_CODE_LENGTH,
    nullable: true,
  } as const,
  userId: {
    type: 'string',
    maxLength: MAX_SHORT_CODE_LENGTH,
    nullable: true,
  } as const,
  retryCount: {
    type: 'integer',
    minimum: 0,
    maximum: 1000,
    nullable: true,
  } as const,
} as const;

/**
 * List of `BaseEvent` fields that MUST be present on every event.
 * Optional base fields are validated by shape (when present) but not
 * required.
 */
export const BASE_EVENT_REQUIRED = [
  'eventId',
  'eventType',
  'timestamp',
  'tenantId',
  'version',
] as const;

/**
 * Reusable UUID schema fragment — identical to `BASE_EVENT_PROPERTIES.tenantId`
 * but named so per-event schemas can reference it for business-id fields
 * like `batchId`, `tankId`, `farmId`, `siteId`. Exported separately from
 * the BaseEvent block because event payloads frequently need UUIDs in
 * fields that are not part of BaseEvent.
 */
export const UUID_SCHEMA = {
  type: 'string',
  pattern: UUID_PATTERN,
} as const;

/**
 * Reusable optional UUID fragment for fields that are `uuid | undefined`
 * on the contract. AJV does not need a special construct for optional
 * fields — the absence from `required` is enough — but the shape
 * definition must still match when the value IS present.
 */
export const OPTIONAL_UUID_SCHEMA = UUID_SCHEMA;
