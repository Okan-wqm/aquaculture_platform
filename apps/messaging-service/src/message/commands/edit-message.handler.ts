import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';

import { EditMessageCommand } from './edit-message.command';
import { Message } from '../entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
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
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  async execute(command: EditMessageCommand): Promise<Message> {
    const { tenantId, userId, messageId, newContent } = command;

    // 1. Find the message
    const message = await this.messageRepo.findOne({
      where: { id: messageId, isDeleted: false },
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
    const updatedMessage = await this.dataSource.transaction(async (manager) => {
      message.content = sanitized;
      message.editedAt = new Date();
      const saved = await manager.save(Message, message);

      const outboxEvent = manager.create(MessagingOutbox, {
        eventType: 'MessageUpdated',
        payload: {
          eventId: uuidv4(),
          tenantId,
          channelId: message.channelId,
          messageId: saved.id,
          senderId: userId,
          editedAt: saved.editedAt?.toISOString() ?? null,
        },
      });
      await manager.save(MessagingOutbox, outboxEvent);

      return saved;
    });

    this.logger.debug(`Message edited: id=${updatedMessage.id}, by=${userId}`);
    return updatedMessage;
  }
}
