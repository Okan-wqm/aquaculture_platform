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
  publishTo<TEvent extends IEvent>(topic: string, event: TEvent): Promise<void>;
}

export interface EventPublishAck {
  stream: string;
  sequence: number;
  duplicate: boolean;
}

/** Narrow contract for commit→JetStream chains that must persist the PubAck. */
export interface IAcknowledgedEventPublisher {
  publishToWithAck<TEvent extends IEvent>(topic: string, event: TEvent): Promise<EventPublishAck>;
}

/** Privileged erasure capability; implemented only by the NATS transport. */
export interface ITenantEventMessageEraser {
  eraseTenantMessages(tenantId: string): Promise<void>;
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
    options?: SubscriptionOptions,
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
    options?: SubscriptionOptions,
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
 * Request-reply primitive exposed by the NATS transport (ADR-031).
 *
 * WHY separate from IEventPublisher / IEventSubscriber — event-bus
 * semantics are fire-and-forget; request-reply is a synchronous
 * round trip with distinct failure modes (timeout, decode, encode
 * as distinct error shelves). Isolating the interface lets a
 * consumer declare "I need request-reply" without pulling in the
 * full event bus surface, and makes it impossible to accidentally
 * call `requestTyped` on a transport that does not support it.
 */
export interface IRequestReply {
  /**
   * Issue a typed request and await the typed reply.
   *
   * `Req` is JSON-encoded to the wire; `Res` is JSON-decoded from
   * the reply bytes. The caller supplies `timeoutMs` so a hung
   * responder never leaks the caller's Promise indefinitely.
   *
   * Throws a `NatsRequestReplyError` subclass (Timeout / Transport
   * / Encode / Decode) so operator alarms can route by shelf
   * without parsing log strings.
   */
  requestTyped<Req, Res>(subject: string, request: Req, options: RequestReplyOptions): Promise<Res>;

  /**
   * Register a responder for `subject`. Each incoming message is
   * JSON-decoded into `Req`, passed to the handler, and the returned
   * `Res` is JSON-encoded and sent back on the message's reply
   * inbox. Decode errors NAK'd (do not starve the subject); handler
   * errors are surfaced to the caller via the reply channel as a
   * structured error payload so the typed client raises a
   * `RequestError` rather than hanging.
   *
   * Returns a handle the caller can `.drain()` during shutdown.
   */
  respond<Req, Res>(
    subject: string,
    handler: RequestReplyHandler<Req, Res>,
    options?: RequestReplyResponderOptions,
  ): Promise<RequestReplyResponderHandle>;
}

/**
 * Per-request tuning knobs for {@link IRequestReply.requestTyped}.
 */
export interface RequestReplyOptions {
  /**
   * Hard wall-clock budget for the round trip. Caller-owned so the
   * client never inherits a library default that drifts from the
   * operator's observability SLO.
   */
  timeoutMs: number;
}

/** Core-NATS responder placement options. */
export interface RequestReplyResponderOptions {
  /**
   * Queue group shared by horizontally scaled instances. Exactly one member
   * handles each request, preventing duplicate authority reads.
   */
  queue?: string;
}

/**
 * Responder callback shape. Must be async — JSON encode / decode
 * boundaries are sync but the handler's own work (DB read,
 * authorisation probe, cert CN check) often is not.
 */
export type RequestReplyHandler<Req, Res> = (
  request: Req,
  context: RequestReplyContext,
) => Promise<Res>;

/**
 * Broker-derived metadata a responder can access about the incoming request.
 * Caller identity is enforced by NATS account/certificate ACLs and is not
 * copied from application-controlled message headers.
 */
export interface RequestReplyContext {
  /** Subject the responder was invoked on. */
  subject: string;
}

/**
 * Handle returned by {@link IRequestReply.respond}. Keeping the
 * drain surface explicit lets services tear responders down in
 * deterministic order during shutdown (responders before the
 * connection close so a mid-flight reply is always sent).
 */
export interface RequestReplyResponderHandle {
  /** Stop accepting new requests + wait for in-flight ones to complete. */
  drain(): Promise<void>;
  /** Observational: the subject this responder is bound to. */
  readonly subject: string;
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
  /**
   * Explicit durable-consumer configuration revision.
   *
   * JetStream does not permit changing every consumer property in place
   * (notably DeliverPolicy). Bumping this value creates a new durable during a
   * rolling migration instead of attempting to mutate the old consumer.
   */
  consumerVersion?: string;
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
