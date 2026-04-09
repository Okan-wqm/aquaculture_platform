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
   * Unique event identifier
   */
  eventId: string;

  /**
   * Event type name for routing (PascalCase, e.g. 'TenantCreated')
   */
  eventType: string;

  /**
   * When the event occurred
   */
  timestamp: Date;

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
   * Optional for backwards compatibility with existing event publishers.
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
 * Create a base event with auto-generated eventId, timestamp, and version.
 *
 * Usage:
 * ```typescript
 * const event: TenantCreatedEvent = {
 *   ...createBaseEvent('TenantCreated', tenantId),
 *   name: tenant.name,
 *   slug: tenant.slug,
 * };
 * ```
 */
export function createBaseEvent<T extends BaseEvent>(
  eventType: T['eventType'],
  tenantId: string,
  overrides?: Partial<Pick<BaseEvent, 'correlationId' | 'causationId' | 'userId' | 'version'>>,
): Pick<BaseEvent, 'eventId' | 'timestamp' | 'tenantId' | 'version'> & { eventType: T['eventType'] } & Partial<BaseEvent> {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date(),
    tenantId,
    version: 1,
    ...overrides,
  } as Pick<BaseEvent, 'eventId' | 'timestamp' | 'tenantId' | 'version'> & { eventType: T['eventType'] } & Partial<BaseEvent>;
}
