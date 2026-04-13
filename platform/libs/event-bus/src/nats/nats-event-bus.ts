import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  StringCodec,
  ConsumerConfig,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  Consumer,
  ConnectionOptions,
} from 'nats';
import * as fs from 'fs';
import * as os from 'os';
import {
  IEventBus,
  IEvent,
  IEventHandler,
  EventBusHealth,
  SubscriptionOptions,
  PublishOptions,
  EventMetadata,
} from '../interfaces/event-bus.interface';
import { EventUpcasterRegistry } from '@platform/event-contracts';
import type { EventBusModuleOptions } from './nats.module';

/**
 * NATS JetStream Event Bus Implementation
 * Enterprise-grade event bus with persistence, replay, and exactly-once delivery
 * Designed for 10K+ tenant scale with proper isolation
 */
@Injectable()
export class NatsEventBus
  implements IEventBus, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NatsEventBus.name);
  private connection: NatsConnection | null = null;
  private jetStream: JetStreamClient | null = null;
  private jetStreamManager: JetStreamManager | null = null;
  private readonly codec = StringCodec();
  private readonly consumers = new Map<string, Consumer>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly handlers = new Map<string, IEventHandler[]>();
  /** Subscriptions requested before JetStream was connected, to be activated on connect. */
  private readonly pendingSubscriptions: Array<{
    subject: string;
    options?: SubscriptionOptions;
  }> = [];
  private lastConnectedAt: Date | null = null;
  private connectionState: 'connected' | 'disconnected' | 'reconnecting' =
    'disconnected';

  // Configuration
  private readonly natsUrl: string;
  private readonly streamName: string;
  private readonly clientId: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectTimeWaitMs: number;
  // Security configuration
  private readonly tlsEnabled: boolean;
  private readonly tlsInsecureAllow: boolean;
  private readonly tlsCaPath?: string;
  private readonly tlsCertPath?: string;
  private readonly tlsKeyPath?: string;
  private readonly authToken?: string;
  private readonly authUser?: string;
  private readonly authPass?: string;

  /** Optional event upcaster registry for v1→v2+ event schema migration */
  private readonly upcasterRegistry?: EventUpcasterRegistry;

  /**
   * IMPORTANT: fail-closed — when true, broker unavailability always prevents
   * module startup regardless of environment.  Production ALWAYS fails closed.
   */
  private readonly requireBroker: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Inject('EVENT_BUS_OPTIONS') @Optional() moduleOptions?: EventBusModuleOptions,
    @Inject('EVENT_UPCASTER_REGISTRY') @Optional() upcasterRegistry?: EventUpcasterRegistry,
  ) {
    this.upcasterRegistry = upcasterRegistry;
    this.requireBroker = moduleOptions?.required ?? false;
    this.natsUrl = this.configService.get<string>(
      'NATS_URL',
      'nats://localhost:4222',
    );
    this.streamName = this.configService.get<string>(
      'NATS_STREAM_NAME',
      'AQUACULTURE_EVENTS',
    );
    // ARCH-020: Use SERVICE_NAME for stable consumer identity across pod restarts.
    // PID-based names caused orphan consumers and duplicate message processing.
    // Same SERVICE_NAME across scaled instances enables JetStream queue-group
    // semantics: messages are load-balanced, not duplicated.
    const serviceName = this.configService.get<string>(
      'SERVICE_NAME',
      os.hostname(),
    );
    this.clientId = this.configService.get<string>(
      'NATS_CLIENT_ID',
      `aquaculture-${serviceName}`,
    );
    this.maxReconnectAttempts = this.configService.get<number>(
      'NATS_MAX_RECONNECT_ATTEMPTS',
      10,
    );
    this.reconnectTimeWaitMs = this.configService.get<number>(
      'NATS_RECONNECT_TIME_WAIT_MS',
      2000,
    );

    // SECURITY: TLS configuration
    this.tlsEnabled = this.configService.get<string>('NATS_TLS_ENABLED', 'false') === 'true';
    this.tlsInsecureAllow = this.configService.get<string>('NATS_TLS_INSECURE_ALLOW') === 'true';
    this.tlsCaPath = this.configService.get<string>('NATS_TLS_CA');
    this.tlsCertPath = this.configService.get<string>('NATS_TLS_CERT');
    this.tlsKeyPath = this.configService.get<string>('NATS_TLS_KEY');

    // SECURITY: Authentication configuration
    this.authToken = this.configService.get<string>('NATS_AUTH_TOKEN');
    this.authUser = this.configService.get<string>('NATS_AUTH_USER');
    this.authPass = this.configService.get<string>('NATS_AUTH_PASS');

    // SECURITY: Production security warnings
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (isProduction) {
      if (!this.tlsEnabled) {
        this.logger.warn(
          '⚠️  SECURITY WARNING: NATS TLS is disabled in production! ' +
          'Set NATS_TLS_ENABLED=true and provide certificates for secure communication.',
        );
      }
      if (!this.authToken && !this.authUser) {
        this.logger.warn(
          '⚠️  SECURITY WARNING: NATS authentication is not configured in production! ' +
          'Set NATS_AUTH_TOKEN or NATS_AUTH_USER/NATS_AUTH_PASS for secure access.',
        );
      }
    }
  }

  /**
   * IMPORTANT: fail-closed — broker availability is an explicit startup dependency.
   *
   * The service MUST NOT boot when NATS is unreachable if:
   *   1. The environment is production (NODE_ENV=production), OR
   *   2. The module was configured with `required: true`.
   *
   * Only non-production environments without the `required` flag fall back to
   * background reconnection.  This prevents services from appearing healthy
   * while async event workflows are silently disabled.
   */
  async onModuleInit(): Promise<void> {
    const isProduction = process.env['NODE_ENV'] === 'production';
    // IMPORTANT: fail-closed — production OR explicit required flag means the
    // service cannot start without a working broker connection.
    const mustHaveBroker = isProduction || this.requireBroker;

    try {
      await this.connect();
      await this.setupStream();
      // Activate any subscriptions that were registered before connect completed
      await this.activatePendingSubscriptions();
    } catch (error) {
      if (mustHaveBroker) {
        this.logger.error(
          `CRITICAL: Failed to connect to NATS (required=${this.requireBroker}, ` +
          `production=${isProduction}). Service startup aborted. ` +
          `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        throw error;
      }
      this.logger.warn(
        `Failed to connect to NATS on startup (non-production, optional). ` +
        `Service will continue without event bus. ` +
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    setTimeout(async () => {
      if (this.connectionState === 'disconnected') {
        this.logger.log('Attempting to reconnect to NATS...');
        try {
          await this.connect();
          await this.setupStream();
          await this.activatePendingSubscriptions();
          this.logger.log('Successfully reconnected to NATS');
        } catch (error) {
          this.logger.warn(
            `Reconnection attempt failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          this.scheduleReconnect();
        }
      }
    }, this.reconnectTimeWaitMs);
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async connect(): Promise<void> {
    try {
      this.connectionState = 'reconnecting';
      this.logger.log(`Connecting to NATS at ${this.natsUrl}...`);

      // Build connection options with security
      const connectionOptions: ConnectionOptions = {
        servers: this.natsUrl.split(','),
        name: this.clientId,
        maxReconnectAttempts: this.maxReconnectAttempts,
        reconnectTimeWait: this.reconnectTimeWaitMs,
        reconnect: true,
      };

      // SECURITY: Two-layer TLS validation — must match nats-connection.factory.ts logic exactly.
      //
      // Layer 1 — URL scheme: `tls://` is the authoritative indicator.
      //   A `nats://` URL with NATS_TLS_ENABLED=true is a misconfiguration.
      //   A `tls://` URL with NATS_TLS_ENABLED=false is a misconfiguration.
      // Layer 2 — Explicit flag: NATS_TLS_ENABLED must agree with the URL scheme.
      //   Disagreement means one side was updated without the other — a deployment bug.
      //
      // Hard-fail on any mismatch so the problem surfaces immediately in the
      // deploy log rather than manifesting as a silent security regression.
      const servers = connectionOptions.servers as string[];
      const usesTls = servers.some((s) => s.startsWith('tls://'));

      if (usesTls !== this.tlsEnabled) {
        const msg = usesTls
          ? 'NATS_URL uses tls:// but NATS_TLS_ENABLED is not "true". ' +
            'Set NATS_TLS_ENABLED=true or change NATS_URL to nats://.'
          : 'NATS_TLS_ENABLED=true but NATS_URL does not use tls://. ' +
            'Change NATS_URL to tls://nats:4222 or set NATS_TLS_ENABLED=false.';
        throw new Error(`[NatsEventBus] Security misconfiguration: ${msg}`);
      }

      if (usesTls) {
        if (!this.tlsCaPath && !this.tlsInsecureAllow) {
          // SECURITY: Hard-fail — connecting to a tls:// broker without a CA cert
          // means the server identity is unverified. On this platform the NATS cert is
          // self-signed by the Aquaculture Internal CA, which is NOT in any container's
          // system trust store, so the connection will always fail at handshake time.
          // Surface the misconfiguration here, at startup, rather than after connect.
          throw new Error(
            '[NatsEventBus] NATS_URL uses tls:// but NATS_TLS_CA is not set. ' +
              'Mount the CA bundle and set NATS_TLS_CA=/etc/ssl/nats-ca.pem. ' +
              'For local-dev smoke tests only, set NATS_TLS_INSECURE_ALLOW=true.',
          );
        }
        connectionOptions.tls = {
          ...(this.tlsCaPath ? { ca: fs.readFileSync(this.tlsCaPath, 'utf8') } : {}),
          ...(this.tlsCertPath ? { cert: fs.readFileSync(this.tlsCertPath, 'utf8') } : {}),
          ...(this.tlsKeyPath ? { key: fs.readFileSync(this.tlsKeyPath, 'utf8') } : {}),
        };
        this.logger.log('NATS TLS enabled with CA verification');
      }

      // SECURITY: Add authentication if configured
      if (this.authToken) {
        connectionOptions.token = this.authToken;
        this.logger.log('NATS token authentication enabled');
      } else if (this.authUser && this.authPass) {
        connectionOptions.user = this.authUser;
        connectionOptions.pass = this.authPass;
        this.logger.log('NATS user/password authentication enabled');
      }

      this.connection = await connect(connectionOptions);

      this.jetStream = this.connection.jetstream();
      this.jetStreamManager = await this.connection.jetstreamManager();

      this.connectionState = 'connected';
      this.lastConnectedAt = new Date();
      this.logger.log('Successfully connected to NATS JetStream');

      // Handle connection events
      this.setupConnectionHandlers();
    } catch (error) {
      this.connectionState = 'disconnected';
      this.logger.error('Failed to connect to NATS', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      // Abort all message processing loops
      for (const [topic, controller] of this.abortControllers) {
        try {
          controller.abort();
          this.logger.log(`Aborted processing for ${topic}`);
        } catch (err) {
          this.logger.warn(`Error aborting ${topic}`, err);
        }
      }
      this.abortControllers.clear();
      this.consumers.clear();

      // Close connection
      if (this.connection) {
        await this.connection.drain();
        await this.connection.close();
        this.connection = null;
        this.jetStream = null;
        this.jetStreamManager = null;
      }

      this.connectionState = 'disconnected';
      this.logger.log('Disconnected from NATS');
    } catch (error) {
      this.logger.error('Error during NATS disconnect', error);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connectionState === 'connected' && this.connection !== null;
  }

  async getHealth(): Promise<EventBusHealth> {
    return {
      isHealthy: this.isConnected(),
      connectionState: this.connectionState,
      lastConnectedAt: this.lastConnectedAt ?? undefined,
      pendingMessages: this.consumers.size,
    };
  }

  /**
   * Derive the tenant-scoped NATS subject for an event.
   *
   * Subject format:
   *   With tenantId:    events.{tenantId}.{eventType}   (tenant-isolated routing)
   *   Without tenantId: events.system.{eventType}       (platform-level events)
   *
   * Consumers that handle all tenants subscribe with wildcard:
   *   events.*.{eventType}   — receives events from every tenant
   *
   * Consumers that handle a single tenant subscribe with:
   *   events.{tenantId}.{eventType}
   *
   * The JetStream stream already has subjects: ['events.>'] so both formats
   * are captured without stream reconfiguration.
   */
  private deriveSubject(event: IEvent): string {
    const segment = event.tenantId ?? 'system';
    return `events.${segment}.${event.eventType}`;
  }

  async publish<TEvent extends IEvent>(
    event: TEvent,
    options?: PublishOptions,
  ): Promise<void> {
    await this.publishTo(this.deriveSubject(event), event, options);
  }

  async publishBatch<TEvent extends IEvent>(events: TEvent[]): Promise<void> {
    await Promise.all(events.map((event) => this.publish(event)));
  }

  async publishTo<TEvent extends IEvent>(
    topic: string,
    event: TEvent,
    _options?: PublishOptions,
  ): Promise<void> {
    if (!this.jetStream) {
      throw new Error('NATS JetStream not connected');
    }

    try {
      const payload = this.serializeEvent(event);
      const subject = this.normalizeSubject(topic);

      // NOTE: Intentionally NO `expect: { lastMsgID: ... }` option here.
      // `expect.lastMsgID` is a CAS-style assertion — it succeeds only on
      // the FIRST publish to an empty stream; every subsequent publish
      // fails with "wrong last msg ID", making publishing impossible in
      // any real-world workload. Event deduplication is already handled
      // by the combination of `msgID` (stable per-event) and the stream's
      // `duplicate_window` — JetStream drops a second publish with the
      // same msgID within the dedup window, which is exactly the
      // idempotency guarantee the outbox worker relies on for retries.
      await this.jetStream.publish(subject, this.codec.encode(payload), {
        msgID: event.eventId,
      });

      this.logger.debug(`Published event ${event.eventType} to ${subject}`);
    } catch (error) {
      this.logger.error(
        `Failed to publish event ${event.eventType}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Subscribe to an event type across ALL tenants.
   *
   * Uses the NATS wildcard `events.*.{eventType}` so this consumer receives
   * events published to `events.{anyTenantId}.{eventType}` and
   * `events.system.{eventType}`.
   *
   * Handlers that need only a single tenant's events should call
   * `subscribeTo('events.{tenantId}.{eventType}', handler)` directly.
   */
  async subscribe<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void> {
    // Wildcard '*' matches any single segment — all tenants and 'system'
    const topic = `events.*.${eventType}`;
    await this.subscribeTo(topic, handler);
  }

  async subscribeTo<TEvent extends IEvent>(
    topic: string,
    handler: IEventHandler<TEvent>,
    options?: SubscriptionOptions,
  ): Promise<void> {
    const subject = this.normalizeSubject(topic);

    // Store handler regardless of connection state so it is ready when
    // the connection comes up.
    if (!this.handlers.has(subject)) {
      this.handlers.set(subject, []);
    }
    this.handlers.get(subject)!.push(handler as IEventHandler);

    if (!this.jetStream) {
      // JetStream is not yet connected.  Queue the subscription so it will
      // be activated once the connection is established.
      this.logger.warn(
        `NATS JetStream not connected yet. Queuing subscription for ${subject}`,
      );
      if (!this.pendingSubscriptions.some((p) => p.subject === subject)) {
        this.pendingSubscriptions.push({ subject, options });
      }
      return;
    }

    // Create consumer if not already subscribed
    if (!this.consumers.has(subject)) {
      await this.createSubscription(subject, options);
    }
  }

  async unsubscribe(eventType: string): Promise<void> {
    // Match the wildcard subject used by subscribe()
    const topic = `events.*.${eventType}`;
    await this.unsubscribeFrom(topic);
  }

  async unsubscribeFrom(topic: string): Promise<void> {
    const subject = this.normalizeSubject(topic);
    const controller = this.abortControllers.get(subject);

    if (controller) {
      controller.abort();
      this.abortControllers.delete(subject);
      this.consumers.delete(subject);
      this.handlers.delete(subject);
      this.logger.log(`Unsubscribed from ${subject}`);
    }
  }

  /**
   * Activate subscriptions that were queued while JetStream was disconnected.
   *
   * IMPORTANT: fail-closed — activation errors are collected and re-thrown
   * so the caller (onModuleInit) can decide whether to abort startup.
   * Previously errors were swallowed per-subscription, allowing the service
   * to boot with partial event handling.
   *
   * @throws {Error} Aggregated error if any pending subscription fails to activate
   */
  private async activatePendingSubscriptions(): Promise<void> {
    if (this.pendingSubscriptions.length === 0) {
      return;
    }

    this.logger.log(
      `Activating ${this.pendingSubscriptions.length} pending subscription(s)...`,
    );

    // Drain the queue (splice so new entries during iteration are not lost)
    const pending = this.pendingSubscriptions.splice(0);
    const failures: Array<{ subject: string; message: string }> = [];

    for (const { subject, options } of pending) {
      try {
        if (!this.consumers.has(subject)) {
          await this.createSubscription(subject, options);
        }
        this.logger.log(`Activated pending subscription for ${subject}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(
          `Failed to activate pending subscription for ${subject}: ${message}`,
        );
        failures.push({ subject, message });
      }
    }

    // IMPORTANT: fail-closed — surface ALL activation failures as a single
    // error so the boot-time decision (throw vs continue) is made by the caller.
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.subject}: ${f.message}`)
        .join('\n');
      throw new Error(
        `Failed to activate ${failures.length} pending subscription(s):\n${summary}`,
      );
    }
  }

  /**
   * Setup the NATS JetStream stream.
   * Creates the stream if missing, or updates existing stream config to enforce
   * current limits and prevent drift from server-side nats.conf changes.
   */
  private async setupStream(): Promise<void> {
    if (!this.jetStreamManager) {
      return;
    }

    const streamConfig = this.getStreamConfig();

    try {
      // ARCH-031: Always update existing stream config to enforce current limits.
      // Prevents drift when nats.conf max_file_store or application limits change.
      await this.jetStreamManager.streams.info(this.streamName);
      this.logger.log(`Stream ${this.streamName} already exists — updating config`);
      await this.jetStreamManager.streams.update(this.streamName, streamConfig);
      this.logger.log(`Updated stream ${this.streamName} configuration`);
    } catch {
      // Stream doesn't exist — create it
      await this.jetStreamManager.streams.add({
        name: this.streamName,
        ...streamConfig,
      });
      this.logger.log(`Created stream ${this.streamName}`);
    }
  }

  /**
   * ARCH-031: Shared JetStream stream configuration.
   * max_bytes MUST be less than nats.conf max_file_store (2GB) to leave headroom
   * for metadata and potential additional streams.
   */
  private getStreamConfig() {
    return {
      subjects: ['events.>', 'commands.>', 'queries.>'],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
      max_bytes: 1536 * 1024 * 1024, // 1.5GB — must be < nats.conf max_file_store (2GB)
      max_msg_size: 1024 * 1024, // 1MB per message
      max_msgs: 1_000_000, // 1M messages safety net
      discard: DiscardPolicy.Old,
      duplicate_window: 2 * 60 * 1_000_000_000, // 2 minutes for deduplication
      num_replicas: 1,
    };
  }

  /**
   * Create a subscription for a subject
   */
  private async createSubscription(
    subject: string,
    options?: SubscriptionOptions,
  ): Promise<void> {
    if (!this.jetStream || !this.jetStreamManager) {
      return;
    }

    const consumerName = this.generateConsumerName(subject);

    try {
      // Create or get a pull-based consumer
      const consumerConfig: Partial<ConsumerConfig> = {
        durable_name: consumerName,
        deliver_policy:
          options?.startFrom === 'beginning'
            ? DeliverPolicy.All
            : DeliverPolicy.New,
        ack_policy: AckPolicy.Explicit,
        ack_wait: (options?.ackWait ?? 30) * 1000000000, // Convert to nanoseconds
        max_deliver: options?.maxRetries ?? 3,
        filter_subject: subject,
      };

      // ARCH-020: Use add() which creates OR updates the durable consumer.
      // Previous approach deleted and recreated, losing ack position on every restart.
      // With stable consumer names (SERVICE_NAME-based), the same durable consumer
      // survives across restarts and scaled replicas share it for load-balanced delivery.
      await this.jetStreamManager.consumers.add(this.streamName, consumerConfig);

      // Get the consumer and create a pull subscription
      const consumer = await this.jetStream.consumers.get(this.streamName, consumerName);

      // Store consumer reference
      this.consumers.set(subject, consumer);

      // Start processing messages with abort support
      this.processMessagesFromConsumer(subject, consumer);

      this.logger.log(`Subscribed to ${subject}`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to ${subject}`, error);
      throw error;
    }
  }

  /**
   * Process messages from a pull-based consumer
   */
  private processMessagesFromConsumer(
    subject: string,
    consumer: Consumer,
  ): void {
    const abortController = new AbortController();
    this.abortControllers.set(subject, abortController);

    const processLoop = async () => {
      try {
        const messages = await consumer.consume({
          callback: async (msg) => {
            try {
              const event = this.deserializeEvent(this.codec.decode(msg.data));
              const handlers = this.handlers.get(subject) ?? [];

              // SECURITY: Handler failures must NOT be swallowed while the
              // message is acked. A swallowed handler error permanently loses
              // the event for that handler. Route failures to retry/DLQ instead.
              let handlerFailed = false;
              for (const handler of handlers) {
                try {
                  await handler.handle(event);
                } catch (handlerError) {
                  handlerFailed = true;
                  this.logger.error(
                    `Handler error for ${event.eventType} — message will be NAK'd for retry`,
                    handlerError,
                  );
                }
              }

              if (handlerFailed) {
                const redeliveryCount = msg.info?.redeliveryCount ?? 0;
                const backoffMs = Math.min(1000 * Math.pow(2, redeliveryCount), 30000);
                msg.nak(backoffMs);
              } else {
                msg.ack();
              }
            } catch (error) {
              this.logger.error(`Message processing error on ${subject}`, error);
              // Exponential backoff on NAK: redelivery delay doubles per attempt
              // msg.info.redeliveryCount gives the number of times the message has been delivered
              const redeliveryCount = msg.info?.redeliveryCount ?? 0;
              const backoffMs = Math.min(1000 * Math.pow(2, redeliveryCount), 30000);
              msg.nak(backoffMs);
            }
          },
        });

        // Keep running until aborted
        abortController.signal.addEventListener('abort', () => {
          messages.stop();
        });
      } catch (err) {
        if (!abortController.signal.aborted) {
          this.logger.error(`Consumer error for ${subject}`, err);
        }
      }
    };

    processLoop().catch((err) => {
      if (!abortController.signal.aborted && !err.message?.includes('consumer closed')) {
        this.logger.error(`Consumer loop error for ${subject}`, err);
      }
    });
  }

  /**
   * Serialize event to JSON string.
   *
   * timestamp is always a string (ISO 8601) per BaseEvent contract.
   * Legacy callers that somehow pass a Date are handled via duck-typing.
   */
  private serializeEvent<TEvent extends IEvent>(event: TEvent): string {
    return JSON.stringify({
      ...event,
      timestamp:
        typeof event.timestamp === 'object' && event.timestamp !== null
          ? (event.timestamp as unknown as Date).toISOString()
          : event.timestamp,
    });
  }

  /**
   * Deserialize JSON string to event.
   * Applies upcasters to migrate legacy event schemas (v1 → v2+) transparently.
   */
  private deserializeEvent(data: string): IEvent {
    let parsed = JSON.parse(data);

    // ARCH-C01: Apply upcasters to migrate legacy event schemas
    if (this.upcasterRegistry) {
      parsed = this.upcasterRegistry.upcast(parsed);
    }

    return {
      ...parsed,
      timestamp: new Date(parsed.timestamp),
    };
  }

  /**
   * Normalize subject to match stream configuration
   */
  private normalizeSubject(topic: string): string {
    // Ensure subject starts with valid prefix
    if (
      !topic.startsWith('events.') &&
      !topic.startsWith('commands.') &&
      !topic.startsWith('queries.')
    ) {
      return `events.${topic}`;
    }
    return topic;
  }

  /**
   * Generate a consumer name from subject
   */
  private generateConsumerName(subject: string): string {
    return `${this.clientId}-${subject.replace(/[.>*]/g, '-')}`;
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(): void {
    if (!this.connection) {
      return;
    }

    // Handle connection status changes
    (async () => {
      for await (const status of this.connection!.status()) {
        switch (status.type) {
          case 'disconnect':
            this.connectionState = 'disconnected';
            this.logger.warn('Disconnected from NATS');
            break;
          case 'reconnecting':
            this.connectionState = 'reconnecting';
            this.logger.log('Reconnecting to NATS...');
            break;
          case 'reconnect':
            this.connectionState = 'connected';
            this.lastConnectedAt = new Date();
            this.logger.log('Reconnected to NATS');
            break;
          case 'error':
            this.logger.error('NATS connection error', status.data);
            break;
        }
      }
    })().catch((err) => {
      this.logger.error('Status monitor error', err);
    });
  }
}

/**
 * Helper function to create an event with metadata
 */
export function createEvent(
  eventType: string,
  tenantId: string,
  metadata?: EventMetadata,
): IEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    tenantId,
    metadata,
  };
}
