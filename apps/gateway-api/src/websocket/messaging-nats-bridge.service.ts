import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, NatsConnection, Subscription, StringCodec, ConnectionOptions } from 'nats';
import { buildNatsConnectionOptions } from '@aquaculture/backend-common/nats';

import { MessagingGateway } from './messaging.gateway';

// ============================================================================
// Types
// ============================================================================

interface MessagingNatsEvent {
  eventId: string;
  eventType: string;
  timestamp: string | Date;
  tenantId: string;
  correlationId?: string;
  channelId?: string;
  messageId?: string;
  userId?: string;
  senderId?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

const TENANT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGING_EVENT_PAYLOAD_BYTES = 64 * 1024;
const PRODUCER_SERVICE_HEADER = 'x-aqua-producer-service';
const CORRELATION_ID_HEADER = 'x-correlation-id';

// ============================================================================
// NATS Event Subjects
// ============================================================================

const MESSAGING_SUBJECTS = [
  'events.*.ChannelMessageSent',
  'events.*.MessageUpdated',
  'events.*.MessageDeleted',
  'events.*.MessageForwarded',
  'events.*.ReactionAdded',
  'events.*.ReactionRemoved',
  'events.*.MessagePinned',
  'events.*.MessageUnpinned',
  'events.*.ChannelCreated',
  'events.*.ChannelMemberAdded',
  'events.*.ChannelMemberRemoved',
  'events.*.MessageRead',
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
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(MessagingGateway) private readonly messagingGateway: MessagingGateway,
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
      const expectedEventType = subject.split('.')[2];
      if (!expectedEventType) {
        this.logger.error(`Malformed messaging bridge subscription subject: ${subject}`);
        continue;
      }

      // Membership removals must reach every gateway pod so each process
      // clears its local socket membership cache before the next broadcast.
      const useQueueGroup = expectedEventType !== 'ChannelMemberRemoved';
      const sub = useQueueGroup
        ? this.connection.subscribe(subject, { queue: 'gateway-messaging' })
        : this.connection.subscribe(subject);
      this.subscriptions.push(sub);
      this.logger.log(
        useQueueGroup
          ? `Subscribed to ${subject} (queue: gateway-messaging)`
          : `Subscribed to ${subject} (fanout: all gateway pods)`,
      );

      (async () => {
        for await (const msg of sub) {
          try {
            const subjectRoute = this.parseSubject(msg.subject, expectedEventType);
            if (!subjectRoute) {
              this.logger.warn(`Dropping messaging event with malformed subject: ${msg.subject}`);
              continue;
            }

            if (msg.data.length > MAX_MESSAGING_EVENT_PAYLOAD_BYTES) {
              this.logger.warn(
                `Dropping messaging event over ${MAX_MESSAGING_EVENT_PAYLOAD_BYTES} bytes: ${msg.subject}`,
              );
              continue;
            }

            const producerService = msg.headers?.get(PRODUCER_SERVICE_HEADER);
            const correlationId = msg.headers?.get(CORRELATION_ID_HEADER);
            if (!producerService || !correlationId) {
              this.logger.warn(
                `Dropping messaging event without producer identity/correlation headers: ${msg.subject}`,
              );
              continue;
            }

            const data = this.sc.decode(msg.data);
            const event = JSON.parse(data) as MessagingNatsEvent;

            if (
              !this.isValidEvent(
                event,
                subjectRoute.tenantId,
                subjectRoute.eventType,
                correlationId,
              )
            ) {
              this.logger.warn(`Invalid messaging NATS event on ${msg.subject}, dropping`);
              continue;
            }

            this.handleEvent({
              ...event,
              tenantId: subjectRoute.tenantId,
              eventType: subjectRoute.eventType,
            });
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
      case 'ChannelMessageSent':
        this.messagingGateway.broadcastNewMessage(
          event.tenantId,
          channelId,
          this.serializeNewMessage(event, channelId),
        );
        break;

      case 'MessageForwarded':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'messageForwarded',
          this.serializeMessageForwarded(event, channelId),
        );
        break;

      case 'ReactionAdded':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'reactionAdded',
          this.serializeReaction(event, channelId),
        );
        break;

      case 'ReactionRemoved':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'reactionRemoved',
          this.serializeReaction(event, channelId),
        );
        break;

      case 'MessagePinned':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'messagePinned',
          this.serializePinEvent(event, channelId),
        );
        break;

      case 'MessageUnpinned':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'messageUnpinned',
          this.serializePinEvent(event, channelId),
        );
        break;

      case 'MessageUpdated':
        this.messagingGateway.broadcastMessageUpdated(
          event.tenantId,
          channelId,
          this.serializeMessageUpdated(event, channelId),
        );
        break;

      case 'MessageDeleted':
        this.messagingGateway.broadcastMessageDeleted(
          event.tenantId,
          channelId,
          this.serializeMessageDeleted(event, channelId),
        );
        break;

      case 'MessageRead':
        this.messagingGateway.broadcastReadReceipt(
          event.tenantId,
          channelId,
          this.serializeReadReceipt(event, channelId),
        );
        break;

      case 'ChannelCreated':
        // ChannelCreated events notify channel members of new channels
        this.messagingGateway.broadcastMessageUpdated(
          event.tenantId,
          channelId,
          this.serializeChannelEvent(event, channelId),
        );
        break;

      case 'ChannelMemberRemoved':
        if (typeof event.userId !== 'string') {
          this.logger.warn('ChannelMemberRemoved missing userId, dropping');
          return;
        }
        this.messagingGateway.evictUserFromChannel(event.tenantId, channelId, event.userId);
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'channelMemberRemoved',
          this.serializeChannelEvent(event, channelId),
        );
        break;

      case 'ChannelMemberAdded':
        this.messagingGateway.broadcastChannelEvent(
          event.tenantId,
          channelId,
          'channelMemberAdded',
          this.serializeChannelEvent(event, channelId),
        );
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
            // Phase D fix: drain and clear the previous subscription array
            // BEFORE re-subscribing. Previously `subscribeToMessagingEvents()`
            // pushed new Subscription objects onto `this.subscriptions` without
            // cleaning up the stale ones, so each reconnect doubled the array
            // and duplicated message processing for every subject.
            this.logger.log(
              'Messaging NATS bridge reconnected — draining stale subscriptions then re-subscribing',
            );
            for (const sub of this.subscriptions) {
              try {
                sub.unsubscribe();
              } catch (error) {
                this.logger.debug(`Stale subscription cleanup error: ${(error as Error).message}`);
              }
            }
            this.subscriptions = [];
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

  private parseSubject(
    subject: string,
    expectedEventType: string,
  ): { tenantId: string; eventType: string } | null {
    const [prefix, tenantId, eventType, ...extra] = subject.split('.');
    if (
      prefix !== 'events' ||
      !tenantId ||
      !eventType ||
      extra.length > 0 ||
      eventType !== expectedEventType ||
      !TENANT_ID_REGEX.test(tenantId)
    ) {
      return null;
    }
    return { tenantId, eventType };
  }

  private isValidEvent(
    event: MessagingNatsEvent,
    subjectTenantId: string,
    subjectEventType: string,
    correlationId?: string,
  ): boolean {
    return (
      typeof event === 'object' &&
      event !== null &&
      typeof event.eventId === 'string' &&
      event.eventId.length > 0 &&
      typeof event.correlationId === 'string' &&
      event.correlationId.length > 0 &&
      (!correlationId || event.correlationId === correlationId) &&
      event.eventType === subjectEventType &&
      event.tenantId === subjectTenantId &&
      (typeof event.timestamp === 'string' || event.timestamp instanceof Date)
    );
  }

  private serializeNewMessage(
    event: MessagingNatsEvent,
    channelId: string,
  ): Record<string, unknown> {
    return {
      channelId,
      message: {
        id: event.messageId,
        channelId,
        senderId: event.senderId,
        content: null,
        contentType: event.contentType,
        parentId: null,
        forwardedFrom: null,
        isDeleted: false,
        createdAt: event.createdAt ?? event.timestamp,
        editedAt: null,
        metadata: event.isAiResponse ? { isAiResponse: true } : null,
        attachments: event.hasAttachments ? undefined : [],
        receipts: [],
      },
    };
  }

  private serializeMessageUpdated(
    event: MessagingNatsEvent,
    channelId: string,
  ): Record<string, unknown> {
    return {
      channelId,
      message: {
        id: event.messageId,
        channelId,
        senderId: event.senderId,
        editedAt: event.editedAt ?? event.timestamp,
      },
    };
  }

  private serializeMessageDeleted(
    event: MessagingNatsEvent,
    _channelId: string,
  ): { messageId: string } {
    return { messageId: typeof event.messageId === 'string' ? event.messageId : '' };
  }

  private serializeReadReceipt(
    event: MessagingNatsEvent,
    channelId: string,
  ): Record<string, unknown> {
    return {
      channelId,
      userId: event.userId,
      messageId: event.messageId,
      readAt: event.readAt ?? event.timestamp,
    };
  }

  private serializeMessageForwarded(
    event: MessagingNatsEvent,
    channelId: string,
  ): Record<string, unknown> {
    return {
      eventType: 'MessageForwarded',
      channelId,
      messageId: event.messageId,
      senderId: event.senderId,
      contentType: event.contentType,
      createdAt: event.createdAt ?? event.timestamp,
    };
  }

  private serializeReaction(event: MessagingNatsEvent, channelId: string): Record<string, unknown> {
    return {
      eventType: event.eventType,
      channelId,
      messageId: event.messageId,
      userId: event.userId,
      emoji: event.emoji,
    };
  }

  private serializePinEvent(event: MessagingNatsEvent, channelId: string): Record<string, unknown> {
    return {
      eventType: event.eventType,
      channelId,
      messageId: event.messageId,
      pinnedBy: event.pinnedBy,
      unpinnedBy: event.unpinnedBy,
    };
  }

  private serializeChannelEvent(
    event: MessagingNatsEvent,
    channelId: string,
  ): Record<string, unknown> {
    return {
      eventType: event.eventType,
      channelId,
      userId: event.userId,
      timestamp: event.timestamp,
    };
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }
}
