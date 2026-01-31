/**
 * Event Publisher Interface
 * Follows Dependency Inversion Principle - abstracts event publishing
 * Enables easy testing and swapping of event bus implementations
 */

/**
 * Base event structure
 */
export interface SensorEvent {
  eventId: string;
  eventType: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  metadata: {
    tenantId: string;
    source: string;
    correlationId?: string;
    retryCount?: number;
  };
}

/**
 * Sensor reading event payload
 */
export interface SensorReadingEventPayload {
  readingId: string;
  sensorId: string;
  tenantId: string;
  readings: Record<string, number | undefined>;
  pondId?: string;
  farmId?: string;
}

/**
 * Parent routing event payload
 */
export interface ParentRoutingEventPayload {
  parentId: string;
  tenantId: string;
  childCount: number;
  processedCount: number;
  errorCount: number;
}

/**
 * Event publish options
 */
export interface PublishOptions {
  /**
   * Whether to retry on failure
   */
  retry?: boolean;

  /**
   * Maximum retry attempts
   */
  maxRetries?: number;

  /**
   * Delay between retries in ms
   */
  retryDelay?: number;

  /**
   * Priority level (higher = more important)
   */
  priority?: 'low' | 'normal' | 'high';

  /**
   * Correlation ID for tracing
   */
  correlationId?: string;
}

/**
 * Publish result
 */
export interface PublishResult {
  success: boolean;
  eventId: string;
  error?: string;
  retriesUsed?: number;
}

/**
 * Event Publisher Interface
 */
export interface IEventPublisher {
  /**
   * Publish a sensor reading event
   */
  publishSensorReading(
    payload: SensorReadingEventPayload,
    options?: PublishOptions,
  ): Promise<PublishResult>;

  /**
   * Publish a parent routing event
   */
  publishParentRouting(
    payload: ParentRoutingEventPayload,
    options?: PublishOptions,
  ): Promise<PublishResult>;

  /**
   * Publish a generic event
   */
  publish(event: SensorEvent, options?: PublishOptions): Promise<PublishResult>;

  /**
   * Publish multiple events in batch
   */
  publishBatch(
    events: SensorEvent[],
    options?: PublishOptions,
  ): Promise<PublishResult[]>;
}

/**
 * Injection token
 */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
