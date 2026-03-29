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
   * Get the total unread message count for a user across all channels.
   * Aggregates per-channel unread counts stored in Redis.
   * Falls back to database count if Redis is unavailable.
   */
  async getUnreadCount(userId: string, tenantId: string): Promise<number> {
    try {
      const pattern = `unread:${tenantId}:${userId}:*`;
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        // Fall back to DB-based count
        return this.getUnreadCountFromDb(userId);
      }

      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.get(key);
      }
      const results = await pipeline.exec();

      let total = 0;
      if (results) {
        for (const [err, value] of results) {
          if (!err && value) {
            total += parseInt(value as string, 10) || 0;
          }
        }
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
          const key = `unread:${tenantId}:${member.userId}:${channelId}`;
          pipeline.incr(key);
        }
      }
      await pipeline.exec();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis incrementUnread failed: ${message}`);
    }
  }

  /**
   * Decrement unread count for a specific user in a channel.
   */
  async decrementUnread(
    userId: string,
    channelId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      const key = `unread:${tenantId}:${userId}:${channelId}`;
      const current = await this.redis.get(key);
      if (current && parseInt(current, 10) > 0) {
        await this.redis.decr(key);
      }
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
