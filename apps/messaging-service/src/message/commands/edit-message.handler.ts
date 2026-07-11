import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { EditMessageCommand } from './edit-message.command';
import { Message } from '../entities/message.entity';
import { sanitizeContent } from '../../shared/sanitize';
import { LegalHoldService } from '../../compliance/services/legal-hold.service';

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
    private readonly dataSource: DataSource,
    // MSG-HIGH-062: edit overwrites message.content IN PLACE with no version
    // history, so under an active legal hold it silently destroys the held text —
    // the same spoliation risk delete-message already guards against. Editing is
    // a destructive mutation of held evidence and MUST honour the identical hold
    // precedence as deletion (messaging-service CLAUDE.md: an active hold blocks
    // destructive actions on in-scope messages).
    private readonly legalHoldService: LegalHoldService,
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

      // 3. Legal hold check — must precede any content mutation (MSG-HIGH-062).
      // Parity with delete-message: an in-place edit destroys the held content,
      // so a channel under an active hold rejects the edit. isUnderLegalHold is
      // fail-closed (throws LegalHoldCheckUnavailable on registry timeout).
      const isHeld = await this.legalHoldService.isUnderLegalHold(
        tenantId,
        message.channelId,
        manager,
      );
      if (isHeld) {
        throw new ForbiddenException(
          `Message ${messageId} cannot be edited: channel is under an active legal hold. ` +
          `Contact your compliance administrator to release the hold before editing messages.`,
        );
      }

      // 4. Sanitize content
      const sanitized = sanitizeContent(newContent);

      // 5. Transactional update: message + outbox
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
