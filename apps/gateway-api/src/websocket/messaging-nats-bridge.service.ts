import { PersistentNatsConnection } from '@aquaculture/backend-common/nats';
// NATS v3 (@nats-io/* 3.x): StringCodec was REMOVED — decode an inbound
// payload via msg.string() (UTF-8), which yields the same bytes the v2
// StringCodec produced, so this bridge stays byte-for-byte compatible with v2
// producers during a rolling deploy.
import type { NatsConnection } from '@nats-io/nats-core';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertSubjectMatchesEvent, buildWildcardEventSubject } from '@platform/event-bus';
import {
  AI_REPLY_DRAFT_SUBSCRIPTION,
  aiReplyDraftSubject,
  isAiReplyDraftSignal,
  isMessagingEventType,
  validateMessagingEvent,
  type AiReplyDraftSignal,
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

/**
 * MSGFIX-FAZ3 3.4 (B-3 head-of-line blocking): maximum events processed
 * concurrently per subscription loop. The loop previously `await`ed
 * `handleEvent` inline, so ONE slow `broadcastHydratedMessage` (NATS
 * hydration request, 5s timeout) blocked EVERY subsequent event on that
 * subject — a burst of new messages on a NATS hiccup backed up the whole
 * bridge. Bounded at 20: `void`-dispatch with a slot semaphore keeps the
 * loop free-running without unbounded promise growth under a backlog.
 */
const MAX_EVENT_CONCURRENCY = 20;

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
  /**
   * PLAT-HIGH-939: keeps trying until the broker answers; the client carries
   * the subscriptions across reconnects, so they are made once per connection.
   */
  private readonly nats = new PersistentNatsConnection({
    name: 'gateway-api-messaging-bridge',
    onConnected: (connection) => this.subscribeToMessagingEvents(connection),
  });

  // ── Bounded-concurrency dispatch state (MSGFIX-FAZ3 3.4 / B-3) ──
  private inflightEvents = 0;
  private readonly eventSlotWaiters: Array<() => void> = [];

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

    this.nats.open();
  }

  async onModuleDestroy(): Promise<void> {
    await this.nats.close();
  }

  private subscribeToMessagingEvents(connection: NatsConnection): void {
    for (const subject of MESSAGING_SUBJECTS) {
      // Use a queue group so that when multiple gateway instances run,
      // each NATS message is delivered to exactly one instance (load-balanced).
      const sub = connection.subscribe(subject, { queue: 'gateway-messaging' });
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

            // MSGFIX-FAZ3 3.4 (B-3): bounded-concurrency dispatch. Awaiting
            // handleEvent inline let ONE slow hydration block the whole
            // subject loop (head-of-line blocking). The dispatch is void-fired
            // through a slot semaphore (MAX_EVENT_CONCURRENCY) so the loop
            // keeps draining while up to 20 events process concurrently.
            // handleEvent is already per-event try/caught below.
            await this.acquireEventSlot();
            void this.processEventBounded(event, msg.subject);
          } catch (error) {
            this.logger.warn(`Failed to process ${subject}: ${(error as Error).message}`);
          }
        }
      })().catch((error) => {
        this.logger.error(`NATS ${subject} subscription loop error: ${(error as Error).message}`);
      });
    }

    this.subscribeToAiReplyDrafts(connection);
  }

  /**
   * MSG-MEDIUM-089: an AI reply's draft, which messaging-service publishes
   * while ai-service writes the reply, goes to the channel room as
   * `aiReplyDraft`. Relayed inline in arrival order, with no hydration and
   * no concurrency slot: each draft frame continues the one before it.
   */
  private subscribeToAiReplyDrafts(connection: NatsConnection): void {
    const sub = connection.subscribe(AI_REPLY_DRAFT_SUBSCRIPTION, {
      queue: 'gateway-messaging',
    });
    this.logger.log(`Subscribed to ${AI_REPLY_DRAFT_SUBSCRIPTION} (queue: gateway-messaging)`);

    (async () => {
      for await (const msg of sub) {
        const signal = this.aiReplyDraftOf(msg.string(), msg.subject);
        if (signal) {
          this.messagingGateway.broadcastAiReplyDraft(signal);
        } else {
          this.logger.warn(`Invalid AI reply draft on ${msg.subject}, dropping`);
        }
      }
    })().catch((error) => {
      this.logger.error(
        `NATS ${AI_REPLY_DRAFT_SUBSCRIPTION} subscription loop error: ${(error as Error).message}`,
      );
    });
  }

  /**
   * The draft a message carries. messaging-service publishes through its Nest
   * client, so the wire form is Nest's event packet `{ pattern, data }`;
   * `data` is checked at this trust boundary and must name the tenant of the
   * subject it arrived on.
   */
  private aiReplyDraftOf(raw: string, subject: string): AiReplyDraftSignal | null {
    let packet: unknown;
    try {
      packet = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof packet !== 'object' || packet === null || !('data' in packet)) {
      return null;
    }
    const { data } = packet;
    if (!isAiReplyDraftSignal(data) || aiReplyDraftSubject(data.tenantId) !== subject) {
      return null;
    }
    return data;
  }

  /** Acquire one concurrency slot; resolves immediately while inflight < cap. */
  private async acquireEventSlot(): Promise<void> {
    if (this.inflightEvents < MAX_EVENT_CONCURRENCY) {
      this.inflightEvents += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.eventSlotWaiters.push(resolve);
    });
    this.inflightEvents += 1;
  }

  /** Release a slot and wake the oldest waiter (FIFO — no starvation). */
  private releaseEventSlot(): void {
    this.inflightEvents -= 1;
    const next = this.eventSlotWaiters.shift();
    if (next) {
      next();
    }
  }

  /** Run handleEvent under the semaphore; the slot is always released. */
  private async processEventBounded(event: MessagingNatsEvent, subject: string): Promise<void> {
    try {
      await this.handleEvent(event);
    } catch (error) {
      this.logger.warn(`Failed to process ${subject}: ${(error as Error).message}`);
    } finally {
      this.releaseEventSlot();
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
        const eventName = event.eventType === 'MessageUpdated' ? 'messageUpdated' : 'newMessage';
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
          this.messagingGateway.evictUserFromChannel(event.tenantId, channelId, removedUserId);
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
      this.logger.warn(`Messaging event subject mismatch: ${(error as Error).message}`);
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

  private stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
    const field = value?.[key];
    return typeof field === 'string' ? field : undefined;
  }

  isConnected(): boolean {
    return this.nats.isConnected();
  }
}
