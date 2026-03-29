import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';

import { DeleteMessageCommand } from './delete-message.command';
import { Message } from '../entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { ChannelMemberRole } from '../../channel/entities/channel-member.entity';

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

    // 3. Transactional soft-delete + outbox
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
