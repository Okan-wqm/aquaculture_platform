import { queryRowsNormalized, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { ChannelMember } from '../../channel/entities/channel-member.entity';
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
 * 3. Writes outbox: MessageRead
 *
 * MSGFIX-FAZ3 3.5: the trailing "recalculate Redis unread" step was REMOVED.
 * It maintained a `unread:{tenantId}:{userId}:{channelId}` STRING that NO
 * reader has ever consumed — the unread count is DB-authoritative
 * (MSG-HIGH-066: MessageService.getUnreadCount + the channel-list subquery
 * both derive from the canonical predicate), so the write was pure dead
 * weight: one extra SELECT + one SETEX-shaped SET after every read receipt,
 * diverging forever from the real (lastReadAt-derived) counts.
 */
@CommandHandler(MarkReadCommand)
export class MarkReadHandler implements ICommandHandler<MarkReadCommand, boolean> {
  private readonly logger = new Logger(MarkReadHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: MarkReadCommand): Promise<boolean> {
    const { tenantId, userId, channelId, messageId } = command;

    const didAdvance = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
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

        if (member.lastReadAt && member.lastReadAt.getTime() >= message.createdAt.getTime()) {
          return false;
        }

        // 2. Transactional: update channel member lastReadAt + create/update receipt + outbox
        // 2a. Update channel_members.lastReadAt
        const updateResult = await manager
          .createQueryBuilder()
          .update(ChannelMember)
          .set({ lastReadAt: message.createdAt })
          .where('"tenantId" = :tenantId AND "channelId" = :channelId AND "userId" = :userId', {
            tenantId,
            channelId,
            userId,
          })
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
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('MessageRead', tenantId),
            channelId,
            messageId: message.id,
            messageCreatedAt: messageCreatedAtIso,
            userId,
            readAt: now.toISOString(),
          },
          manager,
          {
            aggregateId: message.id,
            idempotencyKey: `MessageRead:${tenantId}:${message.id}:${messageCreatedAtIso}:${userId}`,
          },
        );

        return true;
      },
    );

    if (didAdvance) {
      // MSGFIX-FAZ3 3.5: no Redis unread recalculation here anymore — the
      // `unread:{...}` key had no reader (dead write, removed). Unread is
      // derived from lastReadAt at read time by the DB-authoritative paths.
      this.logger.debug(`Marked read: user=${userId}, channel=${channelId}, upTo=${messageId}`);
    } else {
      this.logger.debug(
        `Marked read no-op: user=${userId}, channel=${channelId}, upTo=${messageId}`,
      );
    }

    return true;
  }
}
