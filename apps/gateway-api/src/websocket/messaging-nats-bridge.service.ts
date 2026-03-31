import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, Subscription, StringCodec, ConnectionOptions } from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common';

import { MessagingGateway } from './messaging.gateway';

// ============================================================================
// Types
// ============================================================================

interface MessagingNatsEvent {
  eventId: string;
  eventType: string;
  timestamp: string | Date;
  tenantId: string;
  channelId?: string;
  messageId?: string;
  userId?: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// NATS Event Subjects
// ============================================================================

const MESSAGING_SUBJECTS = [
  'events.MessageSent',
  'events.MessageUpdated',
  'events.MessageDeleted',
  'events.ChannelCreated',
  'events.ChannelMemberAdded',
  'events.ChannelMemberRemoved',
  'events.MessageRead',
] as const;

// ============================================================================
// MessagingNatsBridgeService
// ============================================================================

/**
 * NATS to Socket.IO bridge for messaging events.
 * Subscribes to messaging NATS events and broadcasts to Socket.IO rooms.
 */
@Injectable()
export class MessagingNatsBridgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingNatsBridgeService.name);
  private connection: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private readonly sc = StringCodec();

  constructor(
    private readonly configService: ConfigService,
    private readonly messagingGateway: MessagingGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const natsEnabled = this.configService.get<string>('NATS_ENABLED', 'true') === 'true';
    if (!natsEnabled) {
      this.logger.log('Messaging NATS Bridge is disabled');
      return;
    }

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    /** SEC-H01: Use shared NATS connection factory for consistent auth across all services. */
    const connectionOptions: ConnectionOptions = {
      ...buildNatsConnectionOptions('gateway-api-messaging-bridge'),
    };

    try {
      this.connection = await connect(connectionOptions);
      this.logger.log(`Messaging bridge connected to NATS at ${connectionOptions.servers}`);

      this.subscribeToMessagingEvents();
      this.handleConnectionEvents();
    } catch (error) {
      this.logger.error(`Failed to connect to NATS: ${(error as Error).message}`);
    }
  }

  private subscribeToMessagingEvents(): void {
    if (!this.connection) return;

    for (const subject of MESSAGING_SUBJECTS) {
      // Use a queue group so that when multiple gateway instances run,
      // each NATS message is delivered to exactly one instance (load-balanced).
      const sub = this.connection.subscribe(subject, { queue: 'gateway-messaging' });
      this.subscriptions.push(sub);
      this.logger.log(`Subscribed to ${subject} (queue: gateway-messaging)`);

      (async () => {
        for await (const msg of sub) {
          try {
            const data = this.sc.decode(msg.data);
            const event = JSON.parse(data) as MessagingNatsEvent;

            if (!this.isValidEvent(event)) {
              this.logger.warn(`Invalid messaging NATS event on ${subject}, dropping`);
              continue;
            }

            this.handleEvent(event);
          } catch (error) {
            this.logger.warn(`Failed to process ${subject}: ${(error as Error).message}`);
          }
        }
      })().catch((error) => {
        this.logger.error(`NATS ${subject} subscription loop error: ${(error as Error).message}`);
      });
    }
  }

  private handleEvent(event: MessagingNatsEvent): void {
    const channelId = event.channelId;
    if (!channelId) {
      this.logger.warn(`Messaging event ${event.eventType} missing channelId, dropping`);
      return;
    }

    switch (event.eventType) {
      case 'MessageSent':
        this.messagingGateway.broadcastNewMessage(event.tenantId, channelId, {
          messageId: event.messageId,
          channelId,
          tenantId: event.tenantId,
          userId: event.userId,
          timestamp: event.timestamp,
          ...event.data,
        });
        break;

      case 'MessageUpdated':
        this.messagingGateway.broadcastMessageUpdated(event.tenantId, channelId, {
          messageId: event.messageId,
          channelId,
          tenantId: event.tenantId,
          userId: event.userId,
          timestamp: event.timestamp,
          ...event.data,
        });
        break;

      case 'MessageDeleted':
        this.messagingGateway.broadcastMessageDeleted(event.tenantId, channelId, {
          messageId: event.messageId ?? '',
        });
        break;

      case 'MessageRead':
        this.messagingGateway.broadcastReadReceipt(event.tenantId, channelId, {
          userId: event.userId,
          channelId,
          messageId: event.messageId,
          timestamp: event.timestamp,
        });
        break;

      case 'ChannelCreated':
        // ChannelCreated events notify channel members of new channels
        this.messagingGateway.broadcastMessageUpdated(event.tenantId, channelId, {
          eventType: event.eventType,
          channelId,
          tenantId: event.tenantId,
          userId: event.userId,
          timestamp: event.timestamp,
        });
        break;

      case 'ChannelMemberAdded':
      case 'ChannelMemberRemoved':
        // These events can trigger UI updates for channel member lists
        this.messagingGateway.broadcastMessageUpdated(event.tenantId, channelId, {
          eventType: event.eventType,
          channelId,
          tenantId: event.tenantId,
          userId: event.userId,
          timestamp: event.timestamp,
        });
        break;

      default:
        this.logger.debug(`Unhandled messaging event type: ${event.eventType}`);
    }
  }

  private handleConnectionEvents(): void {
    if (!this.connection) return;

    const connection = this.connection;
    (async () => {
      for await (const status of connection.status()) {
        const statusType = status.type as string;
        switch (statusType) {
          case 'disconnect':
            this.logger.warn('Messaging NATS bridge disconnected');
            break;
          case 'reconnect':
            this.logger.log('Messaging NATS bridge reconnected — re-subscribing');
            this.subscribeToMessagingEvents();
            break;
          case 'error':
            this.logger.error(`Messaging NATS error: ${String(status.data)}`);
            break;
        }
      }
    })().catch((error) => {
      this.logger.error(`NATS status loop error: ${(error as Error).message}`);
    });
  }

  private async disconnect(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    if (this.connection) {
      await this.connection.drain();
      this.logger.log('Messaging NATS bridge connection closed');
    }
  }

  private isValidEvent(event: MessagingNatsEvent): boolean {
    return (
      typeof event === 'object' &&
      event !== null &&
      typeof event.eventType === 'string' &&
      typeof event.tenantId === 'string' &&
      (typeof event.timestamp === 'string' || event.timestamp instanceof Date)
    );
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
