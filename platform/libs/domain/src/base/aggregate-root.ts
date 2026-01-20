import { Entity } from './entity';
import { DomainEvent } from '../events/domain-event';

/**
 * Aggregate Root - Consistency boundary for domain entities
 * Manages domain events and ensures transactional consistency
 * Enterprise-grade implementation for event sourcing support
 */
export abstract class AggregateRoot<TId = string> extends Entity<TId> {
  private _domainEvents: DomainEvent[] = [];
  private _uncommittedEvents: DomainEvent[] = [];

  constructor(id: TId, createdAt?: Date, updatedAt?: Date, version?: number) {
    super(id, createdAt, updatedAt, version);
  }

  /**
   * Get all domain events (committed and uncommitted)
   */
  get domainEvents(): ReadonlyArray<DomainEvent> {
    return [...this._domainEvents];
  }

  /**
   * Get uncommitted events for persistence
   */
  get uncommittedEvents(): ReadonlyArray<DomainEvent> {
    return [...this._uncommittedEvents];
  }

  /**
   * Add a domain event
   */
  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
    this._uncommittedEvents.push(event);
    this.touch();
  }

  /**
   * Clear all domain events after processing
   */
  public clearEvents(): void {
    this._domainEvents = [];
  }

  /**
   * Mark events as committed (persisted)
   */
  public markEventsAsCommitted(): void {
    this._uncommittedEvents = [];
  }

  /**
   * Check if there are uncommitted events
   */
  public hasUncommittedEvents(): boolean {
    return this._uncommittedEvents.length > 0;
  }

  /**
   * Load aggregate from event history (event sourcing)
   */
  public loadFromHistory(events: DomainEvent[]): void {
    for (const event of events) {
      this.apply(event, false);
    }
  }

  /**
   * Apply an event to the aggregate
   * @param event The domain event to apply
   * @param isNew Whether this is a new event or replaying history
   */
  protected apply(event: DomainEvent, isNew: boolean = true): void {
    const handler = this.getEventHandler(event);
    if (handler) {
      handler.call(this, event);
    }
    if (isNew) {
      this.addDomainEvent(event);
    }
  }

  /**
   * Get the handler method for a specific event type
   * Follows convention: on{EventType}
   */
  private getEventHandler(
    event: DomainEvent,
  ): ((event: DomainEvent) => void) | undefined {
    const handlerName = `on${event.eventType}`;
    const handler = (this as Record<string, unknown>)[handlerName];
    if (typeof handler === 'function') {
      return handler as (event: DomainEvent) => void;
    }
    return undefined;
  }
}

/**
 * Tenant-scoped Aggregate Root for multi-tenant systems
 */
export abstract class TenantAggregateRoot<TId = string> extends AggregateRoot<TId> {
  protected readonly _tenantId: string;

  constructor(
    id: TId,
    tenantId: string,
    createdAt?: Date,
    updatedAt?: Date,
    version?: number,
  ) {
    super(id, createdAt, updatedAt, version);
    this._tenantId = tenantId;
  }

  get tenantId(): string {
    return this._tenantId;
  }

  /**
   * Validate tenant context matches
   */
  protected validateTenantContext(tenantId: string): void {
    if (this._tenantId !== tenantId) {
      throw new Error(
        `Tenant context mismatch: expected ${this._tenantId}, got ${tenantId}`,
      );
    }
  }
}
