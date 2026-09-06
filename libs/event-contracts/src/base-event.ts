/**
 * Branded type for event IDs. Can ONLY be produced by `createBaseEvent()`.
 *
 * ARCHITECTURAL INVARIANT: This branded type makes inline event construction
 * a compile-time error. You CANNOT assign a plain `string` to `EventId`:
 *
 *   // COMPILE ERROR — cannot assign string to EventId:
 *   const event = { eventId: crypto.randomUUID(), ... }
 *
 *   // CORRECT — use the factory:
 *   const event = { ...createBaseEvent('EventType', tenantId), ... }
 *
 * This prevents the class of bugs where inline event construction skips
 * required fields (timestamp format, aggregateId, version, etc.).
 */
export type EventId = string & { readonly __brand: unique symbol };

/**
 * Base Event Contract - All events must implement these properties
 * Designed for enterprise multi-tenant aquaculture platform
 *
 * All events MUST be flat objects conforming to this interface.
 * Never wrap business fields inside a nested `payload` or `metadata` object.
 * Use `createBaseEvent()` to construct events with auto-generated fields.
 */
export interface BaseEvent {
  /**
   * Unique event identifier — branded type, only producible by createBaseEvent()
   */
  eventId: EventId;

  /**
   * Event type name for routing (PascalCase, e.g. 'TenantCreated')
   */
  eventType: string;

  /**
   * When the event occurred (ISO 8601 string).
   *
   * WHY string not Date: JSONB serialization converts Date to ISO 8601 string
   * on the wire. Declaring Date here makes the TypeScript interface lie about
   * the runtime type. Consumers that need Date should call `new Date(event.timestamp)`.
   *
   * @example "2026-04-09T14:30:00.000Z"
   */
  timestamp: string;

  /**
   * Tenant identifier for multi-tenancy.
   * MUST be at the top level for NATS subject routing.
   */
  tenantId: string;

  /**
   * ID of the domain aggregate root this event belongs to.
   * Required for event sourcing: enables replaying all events for a specific entity
   * (e.g., all events for subscriptionId='abc-123') and building audit trails per entity.
   *
   * BEFORE this field: events could not be filtered by business entity — only by tenantId.
   * This made event replay and per-aggregate audit trails impossible.
   *
   * Examples: subscriptionId, batchId, sensorId, employeeId, paymentId
   */
  aggregateId?: string;

  /**
   * Type name of the domain aggregate (e.g., 'Subscription', 'Batch', 'Sensor', 'Employee').
   * Paired with aggregateId to enable aggregate-type-aware event routing and replay.
   */
  aggregateType?: string;

  /**
   * Correlation ID for distributed tracing
   */
  correlationId?: string;

  /**
   * Causation ID (ID of the event that caused this one)
   */
  causationId?: string;

  /**
   * User who triggered the event
   */
  userId?: string;

  /**
   * Event schema version for evolution.
   * Bump when fields are renamed or removed.
   */
  version: number;

  /**
   * Number of times this event has been retried after initial delivery failure.
   * Used by consumers and dead-letter processors to implement retry limits.
   * Value is 0 on first delivery; incremented by the retry/DLQ infrastructure.
   */
  retryCount?: number;

  /**
   * Crypto-shred key ID for GDPR erasure support.
   * When set, all PII fields in this event are encrypted with the key identified by
   * this ID. Deleting the key from the key store renders all PII in this event
   * irrecoverable (crypto-shredding).
   *
   * SECURITY: Events containing PII (employeeName, email, nationalId) MUST set this
   * field. Consumers that need PII must decrypt using the key store. If the key is
   * deleted (GDPR erasure), consumers see encrypted gibberish — no replay needed.
   *
   * @see DATA-HIGH-003 (PII in events without crypto-shred support)
   */
  cryptoShredKeyId?: string;
}

/**
 * Canonical PII-class event registry (DATA-LOW-003 cure).
 *
 * # Why this list exists
 *
 * The `cryptoShredKeyId` field on BaseEvent is OPTIONAL (`?:`). The
 * audit-trail invariant requires that EVERY event carrying PII
 * (employee name, email, national ID, billing email, etc.) emit
 * with a non-null `cryptoShredKeyId` so a future GDPR-Art-17
 * erasure can crypto-shred the per-tenant key and render the
 * event payload unrecoverable across every consumer that
 * persisted it.
 *
 * Pre-cure the only event that STRUCTURALLY enforced this was
 * `PasswordResetRequestedEvent` (mandatory `cryptoShredKeyId:
 * string`). Other PII-bearing events relied on per-event author
 * discipline. The systematic policy-by-shape was missing — new
 * events introducing PII without opting in were a slow leak.
 *
 * # How this list works
 *
 * The `PII_BEARING_EVENT_TYPES` array is the canonical
 * declaration: "these eventType strings carry PII; their
 * publishers MUST stamp cryptoShredKeyId." The companion
 * invariant `tests/invariants/pii-events-mandatory-crypto-shred.spec.ts`
 * (added alongside) enforces TWO checks:
 *
 *   1. Every entry in this list resolves to a real event-
 *      contract interface that DECLARES `cryptoShredKeyId:
 *      string` (mandatory; not the optional inherited form).
 *      A new entry without the structural mandatory-ness fails.
 *   2. (Future-extension) Every event interface that mentions
 *      common PII field names (email, name, phoneNumber,
 *      nationalId) is either on this list OR carries an
 *      explicit `// no-pii-event:` marker comment.
 *
 * # How to add a new PII-bearing event
 *
 *   1. Author the interface; declare `cryptoShredKeyId: string`
 *      (mandatory, no `?`).
 *   2. Add the eventType string literal to this array.
 *   3. Update the per-event JSON Schema validator to require
 *      cryptoShredKeyId (if cross-trust-boundary).
 *
 * The architectural-arbiter approves additions; compliance-expert
 * is the CATCHER for the per-event PII categorisation decision.
 */
export const PII_BEARING_EVENT_TYPES: readonly string[] = ['PasswordResetRequested'] as const;

// ==================== Shared Literal Types ====================

/**
 * Canonical plan tier values used across tenant and billing events.
 * All services MUST use these values for tier fields.
 *
 * `free` is a permanent $0 tier (Billing Revival Faz B): a real, non-trial
 * subscription with FREE-plan limits and no Stripe object. It is a first-class
 * tier in the provisioning command so admin-api can no longer silently coerce
 * `free` down to `starter` on the wire.
 */
export type PlanTier = 'free' | 'starter' | 'professional' | 'enterprise';

/**
 * Canonical billing cycle values.
 */
export type BillingCycle = 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

/**
 * The same set, enumerable at runtime — a `type` alone cannot be handed to a
 * `class-validator` `@IsIn`, a TypeORM `enum:` column, or a Postgres enum
 * generator, and each of those previously kept its own hand-written copy.
 * The two guards below make a copy that drifts a compile error.
 */
export const BILLING_CYCLES = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;

/** Both directions hold, so the array IS the union — neither may drift. */
export type BillingCycleRuntimeParity = BillingCycle extends (typeof BILLING_CYCLES)[number]
  ? (typeof BILLING_CYCLES)[number] extends BillingCycle
    ? true
    : never
  : never;

/**
 * Create a base event with auto-generated eventId, timestamp (ISO 8601 string), and version.
 *
 * `aggregateId` and `aggregateType` are required so that every event is properly
 * associated with a domain aggregate for event-sourced replay and per-entity audit trails.
 *
 * Usage:
 * ```typescript
 * const event: TenantCreatedEvent = {
 *   ...createBaseEvent('TenantCreated', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
 *   name: tenant.name,
 *   slug: tenant.slug,
 * };
 * ```
 */
export function createBaseEvent<T extends BaseEvent>(
  eventType: T['eventType'],
  tenantId: string,
  overrides?: Partial<
    Pick<
      BaseEvent,
      'correlationId' | 'causationId' | 'userId' | 'version' | 'aggregateId' | 'aggregateType'
    >
  >,
): Pick<
  BaseEvent,
  'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'
> & { eventType: T['eventType'] } & Partial<BaseEvent> {
  return {
    eventId: crypto.randomUUID() as EventId,
    eventType,
    timestamp: new Date().toISOString(),
    tenantId,
    version: 1,
    aggregateId: '',
    aggregateType: '',
    ...overrides,
  } as Pick<
    BaseEvent,
    'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'
  > & { eventType: T['eventType'] } & Partial<BaseEvent>;
}

/**
 * Canonical domain-date → event-wire (ISO 8601 string) normaliser — the SINGLE
 * conversion point for every date field on an event contract (ORPHAN-111).
 *
 * Event contracts carry dates as ISO `string` (the wire shape the JSON schemas
 * validate, matching `BaseEvent.timestamp`). Producers, however, hold `Date`
 * objects from TypeORM entities — and TypeORM occasionally hands back a `string`
 * for a date column, which is exactly why ad-hoc producer code grew defensive
 * `x instanceof Date ? x : new Date(x)` checks. Routing every producer through
 * this one helper kills that drift: the conversion is defined once, is idempotent
 * (a valid string round-trips), and fails fast on an unparseable value rather
 * than emitting a malformed timestamp onto the wire.
 *
 * Overloaded so a required field stays `string` and an optional field stays
 * `string | undefined` (a nullish input maps to `undefined`, never `"null"`).
 */
export function toEventIso(value: Date | string): string;
export function toEventIso(value: Date | string | null | undefined): string | undefined;
export function toEventIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`toEventIso: unparseable date value: ${String(value)}`);
  }
  return date.toISOString();
}
