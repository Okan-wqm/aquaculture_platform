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
): Pick<BaseEvent, 'eventId' | 'eventType' | 'timestamp' | 'tenantId' | 'version'> & Partial<BaseEvent> {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date(),
    tenantId,
    version: 1,
    ...overrides,
  };
}
