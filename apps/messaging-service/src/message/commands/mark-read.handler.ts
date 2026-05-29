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
      const messageCreatedAt = new Date(message.createdAt);
      const currentLastReadAt = member.lastReadAt ? new Date(member.lastReadAt) : null;
      if (currentLastReadAt !== null && currentLastReadAt.getTime() >= messageCreatedAt.getTime()) {
        return;
      }

      await manager.update(
        ChannelMember,
        {
          tenantId,
          channelId: message.channelId,
          userId,
        },
        { lastReadAt: message.createdAt },
      );

      // 2b. Insert-winner read receipt idempotency.
      // The receipt-key table serializes concurrent markRead calls for the
      // same tenant/message/user before any receipt row is inserted.
      const now = new Date();
      const receiptKeyParams = [tenantId, message.id, message.createdAt, userId];
      const readIdempotencyKey = `MessageRead:${tenantId}:${message.id}:${messageCreatedAt.toISOString()}:${userId}`;
      const insertedKeyRows = (await manager.query(
        `INSERT INTO "message_read_receipt_keys"
           ("tenantId", "messageId", "messageCreatedAt", "userId")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("tenantId", "messageId", "messageCreatedAt", "userId") DO NOTHING
         RETURNING 1`,
        receiptKeyParams,
      )) as Array<{ '?column?': number }>;

      if (insertedKeyRows.length > 0) {
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
      } else {
        await manager.query(
          `SELECT 1
           FROM "message_read_receipt_keys"
           WHERE "tenantId" = $1
             AND "messageId" = $2
             AND "messageCreatedAt" = $3
             AND "userId" = $4
           FOR UPDATE`,
          receiptKeyParams,
        );

        const updatedRows = (await manager.query(
          `UPDATE "message_receipts"
           SET "status" = $5,
               "readAt" = $6,
               "deliveredAt" = COALESCE("deliveredAt", $6)
           WHERE "tenantId" = $1
             AND "messageId" = $2
             AND "messageCreatedAt" = $3
             AND "userId" = $4
           RETURNING "id"`,
          [...receiptKeyParams, ReceiptStatus.READ, now],
        )) as Array<{ id: string }>;

        if (updatedRows.length === 0) {
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
      }

      // 2c. Outbox event
      // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
      if (insertedKeyRows.length > 0) {
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('MessageRead', tenantId),
            channelId,
            messageId: message.id,
            userId,
            readAt: now.toISOString(),
          },
          manager,
          {
            aggregateId: message.id,
            idempotencyKey: readIdempotencyKey,
          },
        );
      }
    });

    // 3. Update Redis unread count (decrement or recalculate)
    await this.safeRedisRecalculateUnread(userId, channelId, tenantId);

    this.logger.debug(`Marked read: user=${userId}, channel=${channelId}, upTo=${messageId}`);
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
        async (queryRunner) =>
          queryRunner.manager.findOne(ChannelMember, {
            where: { tenantId, channelId, userId },
          }),
      );
      if (!member || !member.lastReadAt) return;

      // Count messages after lastReadAt that the user hasn't sent
      const unreadCount = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner) =>
          queryRunner.manager
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
