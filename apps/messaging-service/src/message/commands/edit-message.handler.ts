import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { EditMessageCommand } from './edit-message.command';
import { Message } from '../entities/message.entity';
import { sanitizeContent } from '../../shared/sanitize';
import { LegalHoldDestructiveMutationAuthority } from '../../compliance/services/legal-hold-destructive-mutation.authority';

/**
 * Handler for EditMessageCommand.
 *
 * - Validates the user owns the message
 * - Rejects the edit if the channel is under an active legal hold
 * - Sanitizes the new content
 * - Updates content + editedAt atomically with outbox event
 */
@CommandHandler(EditMessageCommand)
export class EditMessageHandler implements ICommandHandler<EditMessageCommand, Message> {
  private readonly logger = new Logger(EditMessageHandler.name);

  constructor(
    private readonly destructiveMutationAuthority: LegalHoldDestructiveMutationAuthority,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: EditMessageCommand): Promise<Message> {
    const { tenantId, userId, messageId, newContent } = command;

    const updatedMessage = await this.destructiveMutationAuthority.runChannelMutation(
      tenantId,
      async (manager) => {
        const message = await manager.findOne(Message, {
          where: { tenantId, id: messageId, isDeleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!message) {
          throw new NotFoundException(`Message ${messageId} not found.`);
        }
        if (message.senderId !== userId) {
          throw new ForbiddenException('You can only edit your own messages.');
        }
        return { channelId: message.channelId, target: message };
      },
      async ({ manager, target: message }) => {
        message.content = sanitizeContent(newContent);
        message.editedAt = new Date();
        const saved = await manager.save(Message, message);

        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('MessageUpdated', tenantId),
            channelId: message.channelId,
            messageId: saved.id,
            senderId: userId,
            editedAt: saved.editedAt?.toISOString() ?? null,
          },
          manager,
        );

        return saved;
      },
    );

    this.logger.debug(`Message edited: id=${updatedMessage.id}, by=${userId}`);
    return updatedMessage;
  }
}
