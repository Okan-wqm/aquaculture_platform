import { buildNatsConnectionOptions } from '@platform/event-bus/nats-connection';
// NATS v3 (@nats-io/* 3.x). The v2 monolithic `nats` package split into
// transport-node (Node connect) and nats-core (connection + Msg primitives).
// StringCodec was REMOVED — decode an inbound payload via msg.string()
// (UTF-8), which yields the same bytes the v2 StringCodec produced, so this
// bridge stays byte-for-byte compatible with v2 producers during a rolling deploy.
import type { ConnectionOptions, NatsConnection, Subscription } from '@nats-io/nats-core';
import { connect } from '@nats-io/transport-node';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertSubjectMatchesEvent,
  buildWildcardEventSubject,
} from '@platform/event-bus';
import {
  isMessagingEventType,
  validateMessagingEvent,
} from '@platform/event-contracts';

import { MessagingGateway } from './messaging.gateway';

// ============================================================================
// Types
// ============================================================================

interface MessagingNatsEvent {
  eventId: string;
  eventType: string;
  timestamp: string | Date;
  tenantId: string;
  version?: number;
  channelId?: string;
  messageId?: string;
  userId?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ============================================================================
// NATS Event Subjects
// ============================================================================

const MESSAGING_GATEWAY_EVENT_TYPES = [
  'MessageSent',
  'MessageForwarded',
  'MessageUpdated',
  'MessageDeleted',
  'ChannelCreated',
  'ChannelMemberAdded',
  'ChannelMemberRemoved',
  'MessageRead',
] as const;

const MESSAGING_SUBJECTS = MESSAGING_GATEWAY_EVENT_TYPES.map((eventType) =>
  buildWildcardEventSubject(eventType),
);

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
      const servers = Array.isArray(connectionOptions.servers)
        ? connectionOptions.servers.join(',')
        : (connectionOptions.servers ?? 'default');
      this.logger.log(`Messaging bridge connected to NATS at ${servers}`);

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
            // v3: msg.string() replaces StringCodec.decode(msg.data) — same UTF-8 bytes.
            const data = msg.string();
            const event = JSON.parse(data) as MessagingNatsEvent;

            if (!this.isValidEvent(event, msg.subject)) {
              this.logger.warn(`Invalid messaging NATS event on ${msg.subject}, dropping`);
              continue;
            }

            await this.handleEvent(event);
          } catch (error) {
            this.logger.warn(`Failed to process ${subject}: ${(error as Error).message}`);
          }
        }
      })().catch((error) => {
        this.logger.error(`NATS ${subject} subscription loop error: ${(error as Error).message}`);
      });
    }
  }

  private async handleEvent(event: MessagingNatsEvent): Promise<void> {
    const channelId = event.channelId;
    if (!channelId) {
      this.logger.warn(`Messaging event ${event.eventType} missing channelId, dropping`);
      return;
    }

    switch (event.eventType) {
      // Hydrate the thin event into a full WsMessage before emitting, so the
      // client receives the { channelId, message } envelope it renders directly
      // (MSG-CRITICAL-050). The gateway owns the NATS hydration request.
      case 'MessageSent':
      case 'MessageForwarded':
      case 'MessageUpdated': {
        const messageId = event.messageId;
        if (!messageId) {
          this.logger.warn(`${event.eventType} missing messageId, dropping`);
          return;
        }
        const eventName =
          event.eventType === 'MessageUpdated' ? 'messageUpdated' : 'newMessage';
        await this.messagingGateway.broadcastHydratedMessage(
          event.tenantId,
          channelId,
          messageId,
          eventName,
        );
        break;
      }

      case 'MessageDeleted':
        // The gateway adds channelId to the MessageDeletedEnvelope.
        this.messagingGateway.broadcastMessageDeleted(event.tenantId, channelId, {
          messageId: event.messageId ?? '',
        });
        break;

      case 'MessageRead': {
        // ReadReceiptEnvelope uses `readAt` (ISO), not `timestamp`.
        const readAt =
          this.stringField(event, 'readAt') ??
          (event.timestamp instanceof Date
            ? event.timestamp.toISOString()
            : String(event.timestamp));
        this.messagingGateway.broadcastReadReceipt(event.tenantId, channelId, {
          channelId,
          userId: event.userId,
          messageId: event.messageId,
          readAt,
        });
        break;
      }

      case 'ChannelMemberRemoved': {
        const removedUserId =
          this.stringField(event, 'userId') ?? this.stringField(event.data, 'userId');
        if (removedUserId) {
          this.messagingGateway.evictUserFromChannel(
            event.tenantId,
            channelId,
            removedUserId,
          );
        }
        // Channel lifecycle events ride a DISTINCT `channelEvent` name — never
        // `messageUpdated` (which now carries a MessageEnvelope and would corrupt
        // the client message cache). MSG-HIGH-050 / MSG-MEDIUM-050.
        this.messagingGateway.broadcastChannelEvent(event.tenantId, channelId, {
          eventType: event.eventType,
          userId: this.stringField(event, 'userId'),
        });
        break;
      }

      case 'ChannelCreated':
      case 'ChannelMemberAdded':
        this.messagingGateway.broadcastChannelEvent(event.tenantId, channelId, {
          eventType: event.eventType,
          userId: this.stringField(event, 'userId'),
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
        // v3: Status is a discriminated union on `type`; the error variant
        // carries `error: Error` (v2's `status.data` field was removed).
        switch (status.type) {
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
                this.logger.debug(
                  `Stale subscription cleanup error: ${(error as Error).message}`,
                );
              }
            }
            this.subscriptions = [];
            this.subscribeToMessagingEvents();
            break;
          case 'error':
            this.logger.error(
              `Messaging NATS error: ${this.formatStatusData(status.error)}`,
            );
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

  private isValidEvent(event: MessagingNatsEvent, subject: string): boolean {
    if (
      typeof event !== 'object' ||
      event === null ||
      typeof event.eventType !== 'string' ||
      typeof event.tenantId !== 'string' ||
      (typeof event.timestamp !== 'string' && !(event.timestamp instanceof Date))
    ) {
      return false;
    }

    if (!isMessagingEventType(event.eventType)) {
      return false;
    }

    try {
      assertSubjectMatchesEvent(subject, event);
    } catch (error) {
      this.logger.warn(
        `Messaging event subject mismatch: ${(error as Error).message}`,
      );
      return false;
    }

    const validation = validateMessagingEvent(event.eventType, event);
    if (!validation.valid) {
      this.logger.warn(
        `Messaging event contract validation failed for ${event.eventType}: ${validation.errors}`,
      );
      return false;
    }

    return true;
  }

  private stringField(
    value: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const field = value?.[key];
    return typeof field === 'string' ? field : undefined;
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }

  private formatStatusData(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof Error) return data.message;
    return JSON.stringify(data) ?? 'unknown';
  }
}
