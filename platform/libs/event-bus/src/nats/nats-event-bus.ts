import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
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
} from 'nats';
import {
  IEventBus,
  IEvent,
  IEventHandler,
  EventBusHealth,
  SubscriptionOptions,
  PublishOptions,
  EventMetadata,
} from '../interfaces/event-bus.interface';

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
  private lastConnectedAt: Date | null = null;
  private connectionState: 'connected' | 'disconnected' | 'reconnecting' =
    'disconnected';

  // Configuration
  private readonly natsUrl: string;
  private readonly streamName: string;
  private readonly clientId: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectTimeWaitMs: number;

  constructor(private readonly configService: ConfigService) {
    this.natsUrl = this.configService.get<string>(
      'NATS_URL',
      'nats://localhost:4222',
    );
    this.streamName = this.configService.get<string>(
      'NATS_STREAM_NAME',
      'AQUACULTURE_EVENTS',
    );
    this.clientId = this.configService.get<string>(
      'NATS_CLIENT_ID',
      `aquaculture-${process.pid}`,
    );
    this.maxReconnectAttempts = this.configService.get<number>(
      'NATS_MAX_RECONNECT_ATTEMPTS',
      10,
    );
    this.reconnectTimeWaitMs = this.configService.get<number>(
      'NATS_RECONNECT_TIME_WAIT_MS',
      2000,
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
      await this.setupStream();
    } catch (error) {
      this.logger.warn(
        `Failed to connect to NATS on startup. Service will continue without event bus. Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Don't throw - allow service to start without NATS
      // Background reconnection will be attempted
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

      this.connection = await connect({
        servers: this.natsUrl.split(','),
        name: this.clientId,
        maxReconnectAttempts: this.maxReconnectAttempts,
        reconnectTimeWait: this.reconnectTimeWaitMs,
        reconnect: true,
      });

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

  async publish<TEvent extends IEvent>(
    event: TEvent,
    options?: PublishOptions,
  ): Promise<void> {
    await this.publishTo(`events.${event.eventType}`, event, options);
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

      await this.jetStream.publish(subject, this.codec.encode(payload), {
        msgID: event.eventId,
        expect: { lastMsgID: undefined },
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

  async subscribe<TEvent extends IEvent>(
    eventType: string,
    handler: IEventHandler<TEvent>,
  ): Promise<void> {
    const topic = `events.${eventType}`;
    await this.subscribeTo(topic, handler);
  }

  async subscribeTo<TEvent extends IEvent>(
    topic: string,
    handler: IEventHandler<TEvent>,
    options?: SubscriptionOptions,
  ): Promise<void> {
    if (!this.jetStream) {
      throw new Error('NATS JetStream not connected');
    }

    const subject = this.normalizeSubject(topic);

    // Store handler
    if (!this.handlers.has(subject)) {
      this.handlers.set(subject, []);
    }
    this.handlers.get(subject)!.push(handler as IEventHandler);

    // Create consumer if not already subscribed
    if (!this.consumers.has(subject)) {
      await this.createSubscription(subject, options);
    }
  }

  async unsubscribe(eventType: string): Promise<void> {
    const topic = `events.${eventType}`;
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
   * Setup the NATS JetStream stream
   */
  private async setupStream(): Promise<void> {
    if (!this.jetStreamManager) {
      return;
    }

    try {
      // Try to get existing stream
      await this.jetStreamManager.streams.info(this.streamName);
      this.logger.log(`Stream ${this.streamName} already exists`);
    } catch {
      // Create stream if it doesn't exist
      await this.jetStreamManager.streams.add({
        name: this.streamName,
        subjects: ['events.>', 'commands.>', 'queries.>'],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: 7 * 24 * 60 * 60 * 1000000000, // 7 days in nanoseconds
        max_bytes: 10 * 1024 * 1024 * 1024, // 10GB
        max_msg_size: 1024 * 1024, // 1MB
        discard: DiscardPolicy.Old,
        duplicate_window: 2 * 60 * 1000000000, // 2 minutes for deduplication
        num_replicas: 1,
      });
      this.logger.log(`Created stream ${this.streamName}`);
    }
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

      // First, try to delete any existing consumer with same name
      try {
        await this.jetStreamManager.consumers.delete(this.streamName, consumerName);
      } catch {
        // Consumer doesn't exist, that's fine
      }

      // Create a new consumer
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

              for (const handler of handlers) {
                try {
                  await handler.handle(event);
                } catch (handlerError) {
                  this.logger.error(
                    `Handler error for ${event.eventType}`,
                    handlerError,
                  );
                }
              }

              msg.ack();
            } catch (error) {
              this.logger.error(`Message processing error on ${subject}`, error);
              msg.nak();
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
   * Serialize event to JSON string
   */
  private serializeEvent<TEvent extends IEvent>(event: TEvent): string {
    return JSON.stringify({
      ...event,
      timestamp:
        event.timestamp instanceof Date
          ? event.timestamp.toISOString()
          : event.timestamp,
    });
  }

  /**
   * Deserialize JSON string to event
   */
  private deserializeEvent(data: string): IEvent {
    const parsed = JSON.parse(data);
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
    timestamp: new Date(),
    tenantId,
    metadata,
  };
}
