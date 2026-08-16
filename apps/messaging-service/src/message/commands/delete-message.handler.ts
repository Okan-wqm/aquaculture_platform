import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { DeleteMessageCommand } from './delete-message.command';
import { Message } from '../entities/message.entity';
import { ChannelMemberRole } from '../../channel/entities/channel-member.entity';
import { LegalHoldDestructiveMutationAuthority } from '../../compliance/services/legal-hold-destructive-mutation.authority';

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
    private readonly destructiveMutationAuthority: LegalHoldDestructiveMutationAuthority,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteMessageCommand): Promise<boolean> {
    const { tenantId, userId, messageId, channelRole } = command;

    await this.destructiveMutationAuthority.runChannelMutation(
      tenantId,
      async (manager) => {
        const message = await manager.findOne(Message, {
          where: { tenantId, id: messageId, isDeleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!message) {
          throw new NotFoundException(`Message ${messageId} not found.`);
        }

        const isOwner = message.senderId === userId;
        const isPrivilegedRole = channelRole !== null && PRIVILEGED_ROLES.includes(channelRole);
        if (!isOwner && !isPrivilegedRole) {
          throw new ForbiddenException(
            'Only the message sender or channel admin/owner can delete messages.',
          );
        }

        return { channelId: message.channelId, target: message };
      },
      async ({ manager, target: message }) => {
        message.isDeleted = true;
        await manager.save(Message, message);

        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('MessageDeleted', tenantId),
            channelId: message.channelId,
            messageId: message.id,
            deletedBy: userId,
            deletedAt: new Date().toISOString(),
          },
          manager,
        );
      },
    );

    this.logger.debug(`Message soft-deleted: id=${messageId}, by=${userId}, role=${channelRole}`);
    return true;
  }
}
