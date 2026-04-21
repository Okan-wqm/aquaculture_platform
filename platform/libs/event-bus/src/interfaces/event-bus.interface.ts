/**
 * Event Bus Interfaces - Abstractions for event-driven communication
 * Supports multiple implementations (NATS, Kafka, RabbitMQ)
 */

/**
 * Base event interface
 * Matches BaseEvent from event-contracts for compatibility
 */
export interface IEvent {
  eventId: string | import('@platform/event-contracts').EventId;
  eventType: string;
  /**
   * ISO 8601 timestamp string.
   * Aligned with BaseEvent.timestamp (string, not Date) to match
   * JSONB wire format and prevent type lie.
   * @see DATA-MEDIUM-011
   */
  timestamp: string;
  tenantId?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version?: number;
  retryCount?: number;
  metadata?: EventMetadata;
}

/**
 * Event metadata for tracing and multi-tenancy
 */
export interface EventMetadata {
  tenantId?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version?: number;
  source?: string;
}

/**
 * Event handler interface
 */
export interface IEventHandler<TEvent extends IEvent = IEvent> {
  /**
   * Handle the event
   */
  handle(event: TEvent): Promise<void>;

  /**
   * Get the event type this handler processes
   */
  getEventType(): string;
}

/**
 * Event publisher interface
 */
export interface IEventPublisher {
  /**
   * Publish a single event
   */
  publish<TEvent extends IEvent>(event: TEvent): Promise<void>;

  /**
   * Publish multiple events
   */
  publishBatch<TEvent extends IEvent>(events: TEvent[]): Promise<void>;

  /**
   * Publish to a specific topic/subject
   */
  publishTo<TEvent extends IEvent>(
    topic: string,
    event: TEvent,
  ): Promise<void>;
}

/**
 * Event subscriber interface
 */
export interface IEventSubscriber {
  /**
   * Subscribe to an event type.
   *
   * NOTE: existing helper kept on the interface so callers compiled against
   * older versions of @platform/event-bus do not break. New consumers should
   * pick `subscribeWildcard` (cross-tenant) or `subscribeForTenant`
   * (per-tenant) — those names express intent at the call site, removing the
   * ambiguity that lets a consumer accidentally write a 2-segment subject
   * that never matches the publisher's 3-segment `events.{tenantId}.{type}`.
   */
  subscribe<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void>;

  /**
   * Subscribe to an event type ACROSS EVERY TENANT.
   *
   * WHAT — Builds the NATS subject `events.*.{eventType}` so a single
   * subscription captures every tenant-scoped publish from the
   * publisher's `deriveSubject` (which emits `events.{tenantId}.{eventType}`).
   *
   * WHY — Publisher and subscriber must agree on segment count exactly:
   * NATS subject matching is segment-by-segment, so a 2-segment subscribe
   * (`events.{eventType}`) silently misses every 3-segment publish. This
   * helper makes the wildcard explicit at the call site so the agreement
   * is impossible to break by accident (Tier-1 "make it impossible").
   *
   * Use for system-wide consumers: alert-engine, AI, audit,
   * cross-tenant analytics.
   *
   * @see subscribeForTenant for per-tenant subscription.
   */
  subscribeWildcard<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void>;

  /**
   * Subscribe to an event type FOR A SPECIFIC TENANT only.
   *
   * WHAT — Builds the NATS subject `events.{tenantId}.{eventType}` so the
   * subscriber receives only that tenant's events.
   *
   * WHY — Per-tenant subscription is load-bearing for: per-tenant durable
   * JetStream consumers, GDPR delete-per-tenant, noisy-neighbour isolation,
   * and per-tenant dashboards. Building the subject string by hand at the
   * call site is the drift surface ORPHAN-013 documented; this helper is the
   * one well-typed primitive that produces the exact subject the publisher
   * emits for the same tenant.
   *
   * @see subscribeWildcard for system-wide subscription.
   */
  subscribeForTenant<TEvent extends IEvent>(
    eventType: string,
    tenantId: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void>;

  /**
   * Subscribe to a specific topic/subject
   */
  subscribeTo<TEvent extends IEvent>(
    topic: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void>;

  /**
   * Unsubscribe from an event type
   */
  unsubscribe(eventType: string): Promise<void>;

  /**
   * Unsubscribe from a specific topic
   */
  unsubscribeFrom(topic: string): Promise<void>;
}

/**
 * Full event bus interface combining publisher and subscriber
 */
export interface IEventBus extends IEventPublisher, IEventSubscriber {
  /**
   * Connect to the message broker
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the message broker
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Get connection health status
   */
  getHealth(): Promise<EventBusHealth>;
}

/**
 * Event bus health status
 */
export interface EventBusHealth {
  isHealthy: boolean;
  connectionState: 'connected' | 'disconnected' | 'reconnecting';
  lastConnectedAt?: Date;
  pendingMessages?: number;
  errorMessage?: string;
}

/**
 * Event bus configuration
 */
export interface EventBusConfig {
  type: 'nats' | 'kafka' | 'rabbitmq';
  connectionUrl: string;
  clientId?: string;
  groupId?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  maxReconnectAttempts?: number;
  reconnectTimeWaitMs?: number;
}

/**
 * Subscription options
 */
export interface SubscriptionOptions {
  groupId?: string;
  durable?: boolean;
  startFrom?: 'beginning' | 'latest' | Date;
  maxInflight?: number;
  ackWait?: number;
  maxRetries?: number;
}

/**
 * Publish options
 */
export interface PublishOptions {
  headers?: Record<string, string>;
  timeout?: number;
  persistent?: boolean;
  priority?: number;
}
