import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { EditMessageCommand } from './edit-message.command';
import { Message } from '../entities/message.entity';
import { sanitizeContent } from '../../shared/sanitize';

/**
 * Handler for EditMessageCommand.
 *
 * - Validates the user owns the message
 * - Sanitizes the new content
 * - Updates content + editedAt atomically with outbox event
 */
@CommandHandler(EditMessageCommand)
export class EditMessageHandler implements ICommandHandler<EditMessageCommand, Message> {
  private readonly logger = new Logger(EditMessageHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: EditMessageCommand): Promise<Message> {
    const { tenantId, userId, messageId, newContent } = command;

    const updatedMessage = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;

      // 1. Find the message
      const message = await manager.findOne(Message, {
        where: { tenantId, id: messageId, isDeleted: false },
      });
      if (!message) {
        throw new NotFoundException(`Message ${messageId} not found.`);
      }

      // 2. Validate ownership
      if (message.senderId !== userId) {
        throw new ForbiddenException('You can only edit your own messages.');
      }

      // 3. Sanitize content
      const sanitized = sanitizeContent(newContent);

      // 4. Transactional update: message + outbox
      message.content = sanitized;
      message.editedAt = new Date();
      const saved = await manager.save(Message, message);

      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessageUpdated', tenantId),
        channelId: message.channelId,
        messageId: saved.id,
        senderId: userId,
        editedAt: saved.editedAt?.toISOString() ?? null,
      },  manager);

      return saved;
    });

    this.logger.debug(`Message edited: id=${updatedMessage.id}, by=${userId}`);
    return updatedMessage;
  }
}
