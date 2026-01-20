/**
 * Event Bus Interfaces - Abstractions for event-driven communication
 * Supports multiple implementations (NATS, Kafka, RabbitMQ)
 */

/**
 * Base event interface
 * Matches BaseEvent from event-contracts for compatibility
 */
export interface IEvent {
  eventId: string;
  eventType: string;
  timestamp: Date;
  tenantId?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version?: number;
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
   * Subscribe to an event type
   */
  subscribe<TEvent extends IEvent>(
    eventType: string,
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
