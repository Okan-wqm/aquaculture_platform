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

// ==================== Shared Literal Types ====================

/**
 * Canonical plan tier values used across tenant and billing events.
 * All services MUST use these values for tier fields.
 */
export type PlanTier = 'starter' | 'professional' | 'enterprise';

/**
 * Canonical billing cycle values.
 */
export type BillingCycle = 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

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
  overrides?: Partial<Pick<BaseEvent, 'correlationId' | 'causationId' | 'userId' | 'version' | 'aggregateId' | 'aggregateType'>>,
): Pick<BaseEvent, 'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'> & { eventType: T['eventType'] } & Partial<BaseEvent> {
  return {
    eventId: crypto.randomUUID() as EventId,
    eventType,
    timestamp: new Date().toISOString(),
    tenantId,
    version: 1,
    aggregateId: '',
    aggregateType: '',
    ...overrides,
  } as Pick<BaseEvent, 'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'> & { eventType: T['eventType'] } & Partial<BaseEvent>;
}
