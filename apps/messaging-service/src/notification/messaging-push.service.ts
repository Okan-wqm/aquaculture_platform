/**
 * @module MessagingPushService
 * @description Subscribes to ChannelMessageSent outbox events and dispatches
 * push notification commands to the notification-service. Applies filtering:
 * skip sender, skip online users (Redis presence), respect notification preferences.
 * SECURITY: Message content is NEVER included in push payloads.
 * @see ADR-012 section 5 (Push Notifications)
 */
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

import { IEventBus } from '@platform/event-bus';
import { ChatPushRequestedEvent, createBaseEvent } from '@platform/event-contracts';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { ChannelMember, NotificationPreference } from '../channel/entities/channel-member.entity';
import { PresenceService } from '../presence/presence.service';
import { Message } from '../message/entities/message.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';

/** Deduplication window: max 1 push per user per channel within this period (seconds). */
const DEDUP_TTL_SECONDS = 30;
const NOTIFICATION_REF_TTL_SECONDS = 15 * 60;

interface ChannelMessageSentPayload {
  eventId: string;
  tenantId: string;
  channelId: string;
  messageId: string;
  senderId: string;
  contentType: string;
  hasAttachments: boolean;
  createdAt: string;
  mentionedUserIds?: string[];
  senderDisplayName?: string;
}

/**
 * Service that listens to durable ChannelMessageSent events and requests
 * push delivery through the platform event bus.
 *
 * Filtering logic:
 * 1. Skip the message sender (no self-notification)
 * 2. Skip members with notificationPreference = 'none' (unless @mentioned)
 * 3. Skip members currently online (Redis presence check)
 * 4. Deduplicate: max 1 push per 30s per user per channel
 */
@Injectable()
export class MessagingPushService implements OnModuleInit {
  private readonly logger = new Logger(MessagingPushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly presenceService: PresenceService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('MessagingPushService initialized — listening for ChannelMessageSent events');
  }

  /**
   * Handle a ChannelMessageSent event from the outbox worker.
   * Called by the NATS event handler or event-handlers module.
   */
  async handleMessageSent(payload: ChannelMessageSentPayload): Promise<void> {
    const { tenantId, channelId, messageId, senderId, mentionedUserIds } = payload;
    const mentionedSet = new Set(mentionedUserIds ?? []);

    try {
      // 1. Load active channel members
      const members = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner) => queryRunner.manager.find(ChannelMember, {
          where: { tenantId, channelId, leftAt: IsNull() },
          select: ['userId', 'notificationPreference'],
        }),
      );

      if (members.length === 0) return;

      // 2. Filter out sender
      const candidates = members.filter((m) => m.userId !== senderId);
      if (candidates.length === 0) return;

      // 3. Filter by notification preference (unless @mentioned)
      const preferenceFiltered = candidates.filter((m) => {
        if (mentionedSet.has(m.userId)) {
          // Always notify mentioned users unless preference is 'none'
          return m.notificationPreference !== NotificationPreference.NONE;
        }
        return m.notificationPreference === NotificationPreference.ALL;
      });

      if (preferenceFiltered.length === 0) return;

      // 4. Check presence — skip online users
      const userIds = preferenceFiltered.map((m) => m.userId);
      const onlineMap = await this.presenceService.getOnlineUsers(tenantId, userIds);

      const offlineUsers = preferenceFiltered.filter((m) => {
        // For @mentions, override presence check (notify even if online)
        if (mentionedSet.has(m.userId)) return true;
        return !onlineMap.get(m.userId);
      });

      if (offlineUsers.length === 0) return;

      // 5. Dedup + dispatch
      for (const member of offlineUsers) {
        const dedupKey = `msg:push:dedup:${tenantId}:${channelId}:${member.userId}`;
        const alreadySent = await this.safeRedisGet(dedupKey);

        if (alreadySent) {
          this.logger.debug(
            `Dedup: skipping push for user ${member.userId} in channel ${channelId}`,
          );
          continue;
        }

        const unreadCount = await this.getUnreadCount(tenantId, channelId, member.userId);

        const notificationRef = randomUUID();
        await this.safeRedisSetEx(
          `msg:push:ref:${tenantId}:${notificationRef}`,
          NOTIFICATION_REF_TTL_SECONDS,
          JSON.stringify({
            tenantId,
            recipientUserId: member.userId,
            channelId,
            messageId,
            createdAt: new Date().toISOString(),
          }),
        );

        const pushEvent: ChatPushRequestedEvent = {
          ...createBaseEvent<ChatPushRequestedEvent>('ChatPushRequested', tenantId, {
            aggregateId: payload.eventId,
            aggregateType: 'ChatPushRequest',
          }),
          recipientUserId: member.userId,
          notificationRef,
          badge: unreadCount,
          notificationType: 'CHAT_MESSAGE',
        };

        await this.eventBus.publish(pushEvent);

        // Set dedup key with TTL
        await this.safeRedisSetEx(dedupKey, DEDUP_TTL_SECONDS, '1');
      }

      this.logger.debug(
        `Push dispatched for ${offlineUsers.length} users in channel ${channelId}`,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to dispatch push notifications for message ${messageId}: ${errMsg}`,
      );
      throw err;
    }
  }

  private async getUnreadCount(
    tenantId: string,
    channelId: string,
    userId: string,
  ): Promise<number> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const member = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId, leftAt: IsNull() },
      });
      if (!member) {
        return 0;
      }

      const query = queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" = :channelId', { channelId })
        .andWhere('m."senderId" != :userId', { userId })
        .andWhere('m."isDeleted" = false');

      if (member.lastReadAt) {
        query.andWhere('m."createdAt" > :lastReadAt', { lastReadAt: member.lastReadAt });
      }

      return query.getCount();
    });
  }

  /** Safe Redis GET with graceful degradation. */
  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Safe Redis SETEX with graceful degradation. */
  private async safeRedisSetEx(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.redis.setex(key, ttl, value);
    } catch (err) {
      this.logger.warn(`Redis SETEX failed: ${(err as Error).message}`);
    }
  }
}
