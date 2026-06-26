import { Injectable, Logger, NotFoundException, ForbiddenException, Inject } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import Redis from 'ioredis';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { unreadMessagePredicateSql } from '../unread-message.predicate';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/**
 * Core domain service for message operations.
 * Handles ownership validation, unread counts (Redis-backed),
 * and shared logic used across commands/queries.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Validates that a user owns a specific message.
   * @throws NotFoundException if message does not exist
   * @returns the Message entity
   */
  async validateMessageOwnership(tenantId: string, messageId: string, userId: string): Promise<Message> {
    const message = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(Message, {
        where: { tenantId, id: messageId, isDeleted: false },
      }),
    );
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found.`);
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException('You can only modify your own messages.');
    }
    return message;
  }

  /**
   * Build the Redis HASH key for a user's per-channel unread counts.
   * Pattern: `msg:{tenantId}:unread:{userId}`
   * Fields within the hash are channelId -> count.
   */
  private unreadHashKey(tenantId: string, userId: string): string {
    return `msg:${tenantId}:unread:${userId}`;
  }

  /**
   * Get the total unread message count for a user across all channels.
   * Uses a Redis HASH (O(N) on fields, not O(N) on the full keyspace).
   * Falls back to database count if Redis is unavailable.
   */
  async getUnreadCount(userId: string, tenantId: string): Promise<number> {
    try {
      const hashKey = this.unreadHashKey(tenantId, userId);
      const allCounts = await this.redis.hgetall(hashKey);

      const entries = Object.values(allCounts);
      if (entries.length === 0) {
        return this.getUnreadCountFromDb(tenantId, userId);
      }

      let total = 0;
      for (const value of entries) {
        total += parseInt(value, 10) || 0;
      }
      return total;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis getUnreadCount failed, falling back to DB: ${message}`);
      return this.getUnreadCountFromDb(tenantId, userId);
    }
  }

  /**
   * Increment unread count for all members of a channel except the sender.
   * Uses HINCRBY on a per-user HASH, avoiding O(N) KEYS scans.
   * Called after a message is sent.
   */
  async incrementUnreadForChannelMembers(
    channelId: string,
    senderId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const members = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        queryRunner.manager.find(ChannelMember, {
          where: { tenantId, channelId, leftAt: IsNull() },
          select: ['userId'],
        }),
      );

      const pipeline = this.redis.pipeline();
      for (const member of members) {
        if (member.userId !== senderId) {
          const hashKey = this.unreadHashKey(tenantId, member.userId);
          pipeline.hincrby(hashKey, channelId, 1);
        }
      }
      await pipeline.exec();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis incrementUnread failed: ${message}`);
    }
  }

  /**
   * Clear unread count for a specific user in a channel.
   * Uses HDEL on the per-user HASH (removes the channelId field entirely).
   */
  async decrementUnread(
    userId: string,
    channelId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const hashKey = this.unreadHashKey(tenantId, userId);
      await this.redis.hdel(hashKey, channelId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis decrementUnread failed: ${message}`);
    }
  }

  /**
   * Fallback: calculate unread from database when Redis is unavailable.
   * Counts messages after lastReadAt across all channels the user is a member of.
   */
  private async getUnreadCountFromDb(tenantId: string, userId: string): Promise<number> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .innerJoin(
          ChannelMember,
          'cm',
          'cm."tenantId" = :tenantId AND cm."channelId" = m."channelId" AND cm."userId" = :userId',
          { tenantId, userId },
        )
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('cm."leftAt" IS NULL')
        // Canonical unread predicate (ORPHAN-100): isDeleted=false AND not own
        // AND newer-than-lastReadAt — shared byte-for-byte with the channel-list
        // badge subquery so the two counts cannot diverge.
        .andWhere(
          unreadMessagePredicateSql({
            msg: 'm',
            lastReadAt: 'cm."lastReadAt"',
            userIdParam: 'userId',
          }),
          { userId },
        )
        .getCount(),
    );
  }
}
