/**
 * @module MessagingPushService
 * @description Subscribes to MessageSent outbox events via NATS and dispatches
 * push notification commands to the notification-service. Applies filtering:
 * skip sender, skip online users (Redis presence), respect notification preferences.
 * SECURITY: Message content is NEVER included in push payloads.
 * @see ADR-012 section 5 (Push Notifications)
 */
import { randomUUID } from 'crypto';

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  NOTIFICATION_COMMAND_SUBJECTS,
  type NotificationSendPushCommand,
  type NotificationSendResult,
} from '@platform/event-contracts';
import Redis from 'ioredis';
import { firstValueFrom, timeout } from 'rxjs';
import { Repository, IsNull } from 'typeorm';

import { ChannelMember, NotificationPreference } from '../channel/entities/channel-member.entity';
import { MessageService } from '../message/services/message.service';
import { PresenceService } from '../presence/presence.service';
import { REDIS_CLIENT } from '../shared/redis.provider';

/** Deduplication window: max 1 push per user per channel within this period (seconds). */
const DEDUP_TTL_SECONDS = 30;
/** Notification refs are short-lived, one-time pointers resolved after app auth. */
const NOTIFICATION_REF_TTL_SECONDS = 10 * 60;
const NOTIFICATION_COMMAND_TIMEOUT_MS = 10_000;

/**
 * MessageSent fan-out payload consumed by the push handler. Mirrors the
 * content-free `MessageSentEvent` contract plus an optional resolved sender
 * display name. Exported so `MessagingPushNatsHandler` shares the exact shape.
 */
export interface MessageSentPayload {
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
 * Service that listens to MessageSent events (published by the outbox worker)
 * and dispatches push notifications to the notification-service via NATS.
 *
 * Filtering logic:
 * 1. Skip the message sender (no self-notification)
 * 2. Skip members with notificationPreference = 'none' (unless @mentioned)
 * 3. Skip members currently online (Redis presence check)
 * 4. Deduplicate: max 1 push per 30s per user per channel
 */
@Injectable()
export class MessagingPushService {
  private readonly logger = new Logger(MessagingPushService.name);

  constructor(
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    private readonly presenceService: PresenceService,
    private readonly messageService: MessageService,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Handle a MessageSent event from the outbox worker.
   * Called by the NATS event handler or event-handlers module.
   */
  async handleMessageSent(payload: MessageSentPayload): Promise<void> {
    const { tenantId, channelId, messageId, senderId, mentionedUserIds } = payload;
    const mentionedSet = new Set(mentionedUserIds ?? []);

    try {
      // 1. Load active channel members
      const members = await this.channelMemberRepo.find({
        where: { channelId, leftAt: IsNull() },
        select: ['userId', 'notificationPreference'],
      });

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
      const senderName = payload.senderDisplayName ?? 'Someone';
      let dispatchedCount = 0;

      for (const member of offlineUsers) {
        const dedupKey = `msg:push:dedup:${tenantId}:${channelId}:${member.userId}`;
        let notificationRefKey: string | undefined;
        try {
          const dedupClaimed = await this.safeRedisSetNx(dedupKey, DEDUP_TTL_SECONDS, messageId);
          if (!dedupClaimed) {
            this.logger.debug(
              `Dedup: skipping push for user ${member.userId} in channel ${channelId}`,
            );
            continue;
          }

          // Get unread count for badge
          const unreadCount = await this.messageService.getUnreadCount(member.userId, tenantId);
          const notificationRef = randomUUID();
          notificationRefKey = this.notificationRefKey(tenantId, member.userId, notificationRef);
          await this.safeRedisSetEx(
            notificationRefKey,
            NOTIFICATION_REF_TTL_SECONDS,
            JSON.stringify({
              tenantId,
              userId: member.userId,
              channelId,
              messageId,
              messageCreatedAt: payload.createdAt,
            }),
          );

          // SECURITY: NEVER include message content or direct channel/message IDs
          // in push payload. The app resolves notificationRef after auth.
          const requestReference = `messaging:${tenantId}:${messageId}:push:${member.userId}`;
          const pushPayload: NotificationSendPushCommand = {
            deliveryId: requestReference,
            requestReference,
            tenantId,
            source: 'messaging-service',
            recipientRef: {
              kind: 'userId',
              ref: member.userId,
            },
            templateId: 'messaging.chat.message.push',
            templateVersion: '1',
            templateVariables: {
              senderName,
              badge: unreadCount,
              type: 'CHAT_MESSAGE',
              notificationRef,
            },
            metadata: {
              type: 'CHAT_MESSAGE',
              notificationRef,
            },
          };

          const result = await firstValueFrom(
            this.natsClient
              .send<
                NotificationSendResult,
                NotificationSendPushCommand
              >(NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH, pushPayload)
              .pipe(timeout(NOTIFICATION_COMMAND_TIMEOUT_MS)),
          );
          if (!result.success) {
            throw new Error(result.error ?? 'Notification command failed');
          }
          dispatchedCount += 1;
        } catch (recipientError) {
          await this.safeRedisDel(dedupKey);
          if (notificationRefKey) {
            await this.safeRedisDel(notificationRefKey);
          }
          this.logger.error(
            `Failed to dispatch push notification for user ${member.userId}: ` +
              `${recipientError instanceof Error ? recipientError.message : String(recipientError)}`,
          );
        }
      }

      this.logger.debug(
        `Push dispatched for ${dispatchedCount}/${offlineUsers.length} users in channel ${channelId}`,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to dispatch push notifications for message ${messageId}: ${errMsg}`,
      );
    }
  }

  /** Redis SETEX used for notification refs; failure must stop dispatch. */
  private async safeRedisSetEx(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.redis.setex(key, ttl, value);
    } catch (err) {
      throw new Error(`Redis SETEX failed: ${(err as Error).message}`);
    }
  }

  private async safeRedisSetNx(key: string, ttl: number, value: string): Promise<boolean> {
    try {
      const result = await this.redis.set(key, value, 'EX', ttl, 'NX');
      return result === 'OK';
    } catch (err) {
      throw new Error(`Redis SET NX EX failed: ${(err as Error).message}`);
    }
  }

  private async safeRedisDel(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Redis DEL failed for ${key}: ${(err as Error).message}`);
    }
  }

  private notificationRefKey(tenantId: string, userId: string, notificationRef: string): string {
    return `msg:push:ref:${tenantId}:${userId}:${notificationRef}`;
  }
}
