/**
 * Base Event Contract - All events must implement these properties
 * Designed for enterprise multi-tenant aquaculture platform
 */
export interface BaseEvent {
  /**
   * Unique event identifier
   */
  eventId: string;

  /**
   * Event type name for routing
   */
  eventType: string;

  /**
   * When the event occurred
   */
  timestamp: Date;

  /**
   * Tenant identifier for multi-tenancy
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
   * Event version for schema evolution
   */
  version?: number;
}

/**
 * Create a base event with defaults
 */
export function createBaseEvent(
  eventType: string,
  tenantId: string,
  overrides?: Partial<BaseEvent>,
): BaseEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date(),
    tenantId,
    version: 1,
    ...overrides,
  };
}
