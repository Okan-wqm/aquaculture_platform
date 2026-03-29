import { Injectable, Logger, NotFoundException, ForbiddenException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';

import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
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
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Validates that a user owns a specific message.
   * @throws NotFoundException if message does not exist
   * @returns the Message entity
   */
  async validateMessageOwnership(messageId: string, userId: string): Promise<Message> {
    const message = await this.messageRepo.findOne({
      where: { id: messageId, isDeleted: false },
    });
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
        return this.getUnreadCountFromDb(userId);
      }

      let total = 0;
      for (const value of entries) {
        total += parseInt(value, 10) || 0;
      }
      return total;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis getUnreadCount failed, falling back to DB: ${message}`);
      return this.getUnreadCountFromDb(userId);
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
      const members = await this.channelMemberRepo.find({
        where: { channelId },
        select: ['userId'],
      });

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
  private async getUnreadCountFromDb(userId: string): Promise<number> {
    const result = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(
        ChannelMember,
        'cm',
        'cm."channelId" = m."channelId" AND cm."userId" = :userId',
        { userId },
      )
      .where('m."isDeleted" = false')
      .andWhere('m."senderId" != :userId', { userId })
      .andWhere('cm."leftAt" IS NULL')
      .andWhere(
        '(cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")',
      )
      .getCount();

    return result;
  }
}
