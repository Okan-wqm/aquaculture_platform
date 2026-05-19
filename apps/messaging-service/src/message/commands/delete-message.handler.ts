import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { DeleteMessageCommand } from './delete-message.command';
import { Message } from '../entities/message.entity';
import { ChannelMemberRole } from '../../channel/entities/channel-member.entity';
import { LegalHoldService } from '../../compliance/services/legal-hold.service';

/** Roles allowed to delete any message in a channel */
const PRIVILEGED_ROLES: string[] = [ChannelMemberRole.OWNER, ChannelMemberRole.ADMIN];

/**
 * Handler for DeleteMessageCommand.
 *
 * - Owner can delete their own message
 * - Channel ADMIN/OWNER can delete any message in that channel
 * - Soft-delete: sets isDeleted=true (content preserved for compliance)
 */
@CommandHandler(DeleteMessageCommand)
export class DeleteMessageHandler implements ICommandHandler<DeleteMessageCommand, boolean> {
  private readonly logger = new Logger(DeleteMessageHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    // LegalHoldService injected to enforce compliance hold checks before deletion.
    // BEFORE this fix: handler had no LegalHoldService — messages in held channels
    // could be soft-deleted by admins, bypassing litigation preservation obligations.
    private readonly legalHoldService: LegalHoldService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteMessageCommand): Promise<boolean> {
    const { tenantId, userId, messageId, channelRole } = command;

    await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;

      // 1. Find the message
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, isDeleted: false },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      // 2. Authorization check
      const isOwner = message.senderId === userId;
      const isPrivilegedRole = channelRole !== null && PRIVILEGED_ROLES.includes(channelRole);

      if (!isOwner && !isPrivilegedRole) {
        throw new ForbiddenException(
          'Only the message sender or channel admin/owner can delete messages.',
        );
      }

      // 3. Legal hold check — must precede any state change.
      const isHeld = await this.legalHoldService.isUnderLegalHold(
        tenantId,
        message.channelId,
        manager,
      );
      if (isHeld) {
        throw new ForbiddenException(
          `Message ${messageId} cannot be deleted: channel is under an active legal hold. ` +
          `Contact your compliance administrator to release the hold before deleting messages.`,
        );
      }

      // 4. Transactional soft-delete + outbox
      message.isDeleted = true;
      await manager.save(Message, message);

      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessageDeleted', tenantId),
        channelId: message.channelId,
        messageId: message.id,
        deletedBy: userId,
        deletedAt: new Date().toISOString(),
      },  manager);
    });

    this.logger.debug(
      `Message soft-deleted: id=${messageId}, by=${userId}, role=${channelRole}`,
    );
    return true;
  }
}
