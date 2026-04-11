import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, NotFoundException, Inject } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';

import { MarkReadCommand } from './mark-read.command';
import { Message } from '../entities/message.entity';
import { MessageReceipt, ReceiptStatus } from '../entities/message-receipt.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/**
 * Handler for MarkReadCommand.
 *
 * 1. Updates channel_members.lastReadAt to the target message's createdAt
 * 2. Creates/updates a MessageReceipt (status: READ)
 * 3. Decrements Redis unread count
 * 4. Writes outbox: MessageRead
 */
@CommandHandler(MarkReadCommand)
export class MarkReadHandler implements ICommandHandler<MarkReadCommand, boolean> {
  private readonly logger = new Logger(MarkReadHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(MessageReceipt)
    private readonly receiptRepo: Repository<MessageReceipt>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async execute(command: MarkReadCommand): Promise<boolean> {
    const { tenantId, userId, channelId, messageId } = command;

    // 1. Find the target message
    const message = await this.messageRepo.findOne({
      where: { id: messageId },
    });
    if (!message) {
      throw new NotFoundException(`Message ${messageId} not found.`);
    }

    // 2. Transactional: update channel member lastReadAt + create/update receipt + outbox
    await this.dataSource.transaction(async (manager) => {
      // 2a. Update channel_members.lastReadAt
      await manager
        .createQueryBuilder()
        .update(ChannelMember)
        .set({ lastReadAt: message.createdAt })
        .where('"channelId" = :channelId AND "userId" = :userId', {
          channelId,
          userId,
        })
        .execute();

      // 2b. Upsert MessageReceipt
      const existingReceipt = await manager.findOne(MessageReceipt, {
        where: {
          messageId: message.id,
          userId,
        },
      });

      const now = new Date();

      if (existingReceipt) {
        existingReceipt.status = ReceiptStatus.READ;
        existingReceipt.readAt = now;
        await manager.save(MessageReceipt, existingReceipt);
      } else {
        const receipt = manager.create(MessageReceipt, {
          id: uuidv4(),
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          userId,
          status: ReceiptStatus.READ,
          deliveredAt: now,
          readAt: now,
          receiptCreatedAt: now,
        });
        await manager.save(MessageReceipt, receipt);
      }

      // 2c. Outbox event
      // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
      const outboxEvent = manager.create(MessagingOutbox, {
        tenantId,
        eventType: 'MessageRead',
        payload: {
          eventId: uuidv4(),
          tenantId,
          channelId,
          messageId: message.id,
          userId,
          readAt: now.toISOString(),
        },
      });
      await manager.save(MessagingOutbox, outboxEvent);
    });

    // 3. Update Redis unread count (decrement or recalculate)
    await this.safeRedisRecalculateUnread(userId, channelId, tenantId);

    this.logger.debug(
      `Marked read: user=${userId}, channel=${channelId}, upTo=${messageId}`,
    );
    return true;
  }

  /**
   * Recalculate unread count in Redis after marking messages as read.
   * Uses a full recount strategy for correctness.
   */
  private async safeRedisRecalculateUnread(
    userId: string,
    channelId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      // Get the updated lastReadAt for this channel member
      const member = await this.channelMemberRepo.findOne({
        where: { channelId, userId },
      });
      if (!member || !member.lastReadAt) return;

      // Count messages after lastReadAt that the user hasn't sent
      const unreadCount = await this.messageRepo
        .createQueryBuilder('m')
        .where('m."channelId" = :channelId', { channelId })
        .andWhere('m."createdAt" > :lastReadAt', { lastReadAt: member.lastReadAt })
        .andWhere('m."senderId" != :userId', { userId })
        .andWhere('m."isDeleted" = false')
        .getCount();

      const redisKey = `unread:${tenantId}:${userId}:${channelId}`;
      await this.redis.set(redisKey, unreadCount.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis unread recalculate failed: ${message}`);
    }
  }
}
