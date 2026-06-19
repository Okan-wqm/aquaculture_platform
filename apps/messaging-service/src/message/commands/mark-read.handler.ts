import {
  queryRowsNormalized,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { Logger, NotFoundException, Inject } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { MessageReceiptLedger } from '../entities/message-receipt-ledger.entity';
import { ReceiptStatus } from '../entities/message-receipt.entity';
import { Message } from '../entities/message.entity';

import { MarkReadCommand } from './mark-read.command';

interface ReceiptLedgerRow {
  receiptId: string;
  receiptCreatedAt: Date;
  deliveredAt: Date | null;
}

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
  ) {}

  async execute(command: MarkReadCommand): Promise<boolean> {
    const { tenantId, userId, channelId, messageId } = command;

    const didAdvance = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;

      // 1. Find the target message
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId },
      });
      if (!message || message.channelId !== channelId) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      const member = await manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId },
      });
      if (!member || member.leftAt) {
        throw new NotFoundException(`Channel member ${userId} not found.`);
      }

      if (
        member.lastReadAt &&
        member.lastReadAt.getTime() >= message.createdAt.getTime()
      ) {
        return false;
      }

      // 2. Transactional: update channel member lastReadAt + create/update receipt + outbox
      // 2a. Update channel_members.lastReadAt
      const updateResult = await manager
        .createQueryBuilder()
        .update(ChannelMember)
        .set({ lastReadAt: message.createdAt })
        .where(
          '"tenantId" = :tenantId AND "channelId" = :channelId AND "userId" = :userId',
          { tenantId, channelId, userId },
        )
        .andWhere('"leftAt" IS NULL')
        .andWhere('("lastReadAt" IS NULL OR "lastReadAt" < :messageCreatedAt)', {
          messageCreatedAt: message.createdAt,
        })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        return false;
      }

      // 2b. Upsert the non-partitioned logical receipt ledger, then mirror the
      // same receipt identity into the partitioned receipt history table.
      const now = new Date();
      const messageCreatedAtIso = message.createdAt.toISOString();
      const ledgerResult = await manager
        .createQueryBuilder()
        .insert()
        .into(MessageReceiptLedger)
        .values({
          tenantId,
          messageId: message.id,
          messageCreatedAt: message.createdAt,
          userId,
          status: ReceiptStatus.READ,
          deliveredAt: now,
          readAt: now,
          updatedAt: now,
        })
        .onConflict(
          `("tenantId", "messageId", "userId") DO UPDATE SET ` +
            `"messageCreatedAt" = EXCLUDED."messageCreatedAt", ` +
            `"status" = EXCLUDED."status", ` +
            `"deliveredAt" = COALESCE("message_receipt_ledger"."deliveredAt", EXCLUDED."deliveredAt"), ` +
            `"readAt" = EXCLUDED."readAt", ` +
            `"updatedAt" = EXCLUDED."updatedAt"`,
        )
        .returning(['receiptId', 'receiptCreatedAt', 'deliveredAt'])
        .execute();
      const ledgerRows = queryRowsNormalized<ReceiptLedgerRow>(ledgerResult.raw);

      const ledger = ledgerRows[0];
      if (!ledger) {
        throw new Error('Message receipt ledger upsert returned no row');
      }

      await manager.query(
        `
          INSERT INTO message_receipts (
            "id",
            "tenantId",
            "messageId",
            "messageCreatedAt",
            "userId",
            "status",
            "deliveredAt",
            "readAt",
            "receiptCreatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT ("id", "receiptCreatedAt")
          DO UPDATE SET
            "status" = EXCLUDED."status",
            "deliveredAt" = COALESCE(message_receipts."deliveredAt", EXCLUDED."deliveredAt"),
            "readAt" = EXCLUDED."readAt"
        `,
        [
          ledger.receiptId,
          tenantId,
          message.id,
          message.createdAt,
          userId,
          ReceiptStatus.READ,
          ledger.deliveredAt ?? now,
          now,
          ledger.receiptCreatedAt,
        ],
      );

      // 2c. Outbox event
      // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessageRead', tenantId),
        channelId,
        messageId: message.id,
        messageCreatedAt: messageCreatedAtIso,
        userId,
        readAt: now.toISOString(),
      },  manager, {
        aggregateId: message.id,
        idempotencyKey: `MessageRead:${tenantId}:${message.id}:${messageCreatedAtIso}:${userId}`,
      });

      return true;
    });

    if (didAdvance) {
      // 3. Update Redis unread count (decrement or recalculate)
      await this.safeRedisRecalculateUnread(userId, channelId, tenantId);
    } else {
      this.logger.debug(
        `Marked read no-op: user=${userId}, channel=${channelId}, upTo=${messageId}`,
      );
    }

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
        .where('m."channelId" = :channelId', { channelId })
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
