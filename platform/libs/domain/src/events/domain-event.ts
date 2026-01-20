/**
 * Domain Event - Base class for all domain events
 * Provides event metadata and immutability
 */
export abstract class DomainEvent {
  public readonly eventId: string;
  public readonly eventType: string;
  public readonly occurredOn: Date;
  public readonly aggregateId: string;
  public readonly aggregateType: string;
  public readonly version: number;
  public readonly metadata: Readonly<Record<string, unknown>>;

  constructor(params: {
    aggregateId: string;
    aggregateType: string;
    version?: number;
    metadata?: Record<string, unknown>;
    eventId?: string;
    occurredOn?: Date;
  }) {
    this.eventId = params.eventId ?? crypto.randomUUID();
    this.eventType = this.constructor.name;
    this.occurredOn = params.occurredOn ?? new Date();
    this.aggregateId = params.aggregateId;
    this.aggregateType = params.aggregateType;
    this.version = params.version ?? 1;
    this.metadata = Object.freeze(params.metadata ?? {});
  }

  /**
   * Get the event as a serializable object
   */
  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      occurredOn: this.occurredOn.toISOString(),
      aggregateId: this.aggregateId,
      aggregateType: this.aggregateType,
      version: this.version,
      metadata: this.metadata,
      payload: this.getPayload(),
    };
  }

  /**
   * Get the event-specific payload - override in subclasses
   */
  protected abstract getPayload(): Record<string, unknown>;
}

/**
 * Interface for domain event with tenant context
 */
export interface ITenantDomainEvent {
  tenantId: string;
}

/**
 * Base class for tenant-scoped domain events
 */
export abstract class TenantDomainEvent
  extends DomainEvent
  implements ITenantDomainEvent
{
  public readonly tenantId: string;

  constructor(params: {
    aggregateId: string;
    aggregateType: string;
    tenantId: string;
    version?: number;
    metadata?: Record<string, unknown>;
    eventId?: string;
    occurredOn?: Date;
  }) {
    super(params);
    this.tenantId = params.tenantId;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      tenantId: this.tenantId,
    };
  }
}
