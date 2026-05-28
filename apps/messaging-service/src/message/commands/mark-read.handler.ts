import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, NotFoundException, Inject, ForbiddenException } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import Redis from 'ioredis';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { MarkReadCommand } from './mark-read.command';
import { Message } from '../entities/message.entity';
import { MessageReceipt, ReceiptStatus } from '../entities/message-receipt.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { TenantPrincipalService } from '../../principal/tenant-principal.service';

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
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tenantPrincipalService: TenantPrincipalService,
  ) {}

  async execute(command: MarkReadCommand): Promise<boolean> {
    const { tenantId, userId, channelId, messageId } = command;

    await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;

      // 1. Find the target message
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, channelId },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      const member = await manager.findOne(ChannelMember, {
        where: { tenantId, channelId: message.channelId, userId, leftAt: IsNull() },
      });
      if (!member) {
        throw new ForbiddenException('You are not an active member of this channel.');
      }

      await this.tenantPrincipalService.upsertActiveUsers(manager, tenantId, [userId]);

      // 2. Transactional: update channel member lastReadAt + create/update receipt + outbox
      // 2a. Update channel_members.lastReadAt
      await manager.update(
        ChannelMember,
        {
          tenantId,
          channelId: message.channelId,
          userId,
        },
        { lastReadAt: message.createdAt },
      );

      // 2b. Upsert MessageReceipt
      const existingReceipt = await manager.findOne(MessageReceipt, {
        where: {
          tenantId,
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
        await manager.query(
          `INSERT INTO "message_read_receipt_keys"
             ("tenantId", "messageId", "messageCreatedAt", "userId")
           VALUES ($1, $2, $3, $4)
           ON CONFLICT ("tenantId", "messageId", "messageCreatedAt", "userId") DO NOTHING`,
          [tenantId, message.id, message.createdAt, userId],
        );

        const receipt = manager.create(MessageReceipt, {
          id: uuidv4(),
          tenantId,
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
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessageRead', tenantId),
        channelId,
        messageId: message.id,
        userId,
        readAt: now.toISOString(),
      },  manager);
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
      const member = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner) => queryRunner.manager.findOne(ChannelMember, {
          where: { tenantId, channelId, userId },
        }),
      );
      if (!member || !member.lastReadAt) return;

      // Count messages after lastReadAt that the user hasn't sent
      const unreadCount = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner) => queryRunner.manager
          .createQueryBuilder(Message, 'm')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" = :channelId', { channelId })
        .andWhere('m."createdAt" > :lastReadAt', { lastReadAt: member.lastReadAt })
        .andWhere('m."senderId" != :userId', { userId })
        .andWhere('m."isDeleted" = false')
          .getCount(),
      );

      const redisKey = `unread:${tenantId}:${userId}:${channelId}`;
      await this.redis.set(redisKey, unreadCount.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis unread recalculate failed: ${message}`);
    }
  }
}
