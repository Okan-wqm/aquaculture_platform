import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';

import { DeleteMessageCommand } from './delete-message.command';
import { Message } from '../entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
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
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    // LegalHoldService injected to enforce compliance hold checks before deletion.
    // BEFORE this fix: handler had no LegalHoldService — messages in held channels
    // could be soft-deleted by admins, bypassing litigation preservation obligations.
    private readonly legalHoldService: LegalHoldService,
  ) {}

  async execute(command: DeleteMessageCommand): Promise<boolean> {
    const { tenantId, userId, messageId, channelRole } = command;

    // 1. Find the message
    const message = await this.messageRepo.findOne({
      where: { id: messageId, isDeleted: false },
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
    // isUnderLegalHold() covers both tenant-wide and channel-specific holds.
    // This is a read-only preflight check; the actual delete only proceeds if clear.
    // BEFORE: no hold check — any admin could delete messages in a litigation hold,
    // destroying evidence and exposing the platform to spoliation sanctions.
    const isHeld = await this.legalHoldService.isUnderLegalHold(tenantId, message.channelId);
    if (isHeld) {
      throw new ForbiddenException(
        `Message ${messageId} cannot be deleted: channel is under an active legal hold. ` +
        `Contact your compliance administrator to release the hold before deleting messages.`,
      );
    }

    // 4. Transactional soft-delete + outbox
    await this.dataSource.transaction(async (manager) => {
      message.isDeleted = true;
      await manager.save(Message, message);

      const outboxEvent = manager.create(MessagingOutbox, {
        eventType: 'MessageDeleted',
        payload: {
          eventId: uuidv4(),
          tenantId,
          channelId: message.channelId,
          messageId: message.id,
          deletedBy: userId,
          deletedAt: new Date().toISOString(),
        },
      });
      await manager.save(MessagingOutbox, outboxEvent);
    });

    this.logger.debug(
      `Message soft-deleted: id=${messageId}, by=${userId}, role=${channelRole}`,
    );
    return true;
  }
}
