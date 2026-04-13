/**
 * @module ForwardMessageHandler
 * @description CQRS handler for ForwardMessageCommand.
 *
 * Flow:
 * 1. Validate user is a member of BOTH source and target channels
 * 2. Fetch the original message (including attachments)
 * 3. Create a new message in the target channel with forwardedFrom set
 * 4. Copy attachment records (reference same storage keys, no file duplication)
 * 5. Insert outbox event: MessageForwarded
 *
 * @see ADR-012 section 5.5 (Message Forwarding)
 */

import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository, IsNull } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { ForwardMessageCommand } from './forward-message.command';
import { Message } from '../entities/message.entity';
import { MessageAttachment } from '../entities/message-attachment.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

@CommandHandler(ForwardMessageCommand)
export class ForwardMessageHandler
  implements ICommandHandler<ForwardMessageCommand, Message>
{
  private readonly logger = new Logger(ForwardMessageHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ForwardMessageCommand): Promise<Message> {
    const {
      tenantId,
      userId,
      sourceMessageId,
      sourceMessageCreatedAt,
      targetChannelId,
    } = command;

    // ── 1. Fetch source message ───────────────────────────────────────
    const sourceMessage = await this.messageRepo.findOne({
      where: { id: sourceMessageId, createdAt: sourceMessageCreatedAt },
      relations: ['attachments'],
    });

    if (!sourceMessage || sourceMessage.isDeleted) {
      throw new NotFoundException(
        `Source message ${sourceMessageId} not found or has been deleted.`,
      );
    }

    // ── 2. Validate dual-channel membership ───────────────────────────
    const [sourceMembership, targetMembership] = await Promise.all([
      this.channelMemberRepo.findOne({
        where: {
          channelId: sourceMessage.channelId,
          userId,
          leftAt: IsNull(),
        },
      }),
      this.channelMemberRepo.findOne({
        where: {
          channelId: targetChannelId,
          userId,
          leftAt: IsNull(),
        },
      }),
    ]);

    if (!sourceMembership) {
      throw new ForbiddenException(
        'You are not a member of the source channel.',
      );
    }
    if (!targetMembership) {
      throw new ForbiddenException(
        'You are not a member of the target channel.',
      );
    }

    // ── 3. Forward within a transaction ───────────────────────────────
    const messageId = uuidv4();
    const now = new Date();

    const forwardedMessage = await this.dataSource.transaction(
      async (manager) => {
        // 3a. Create forwarded message
        // SECURITY: tenantId MUST be set for RLS and event routing.
        const message = manager.create(Message, {
          id: messageId,
          tenantId,
          channelId: targetChannelId,
          senderId: userId,
          content: sourceMessage.content,
          contentType: sourceMessage.contentType,
          parentId: null,
          forwardedFrom: sourceMessageId,
          idempotencyKey: uuidv4(), // Unique key for the forwarded copy
          isDeleted: false,
          createdAt: now,
          editedAt: null,
          metadata: {
            forwardedFromChannel: sourceMessage.channelId,
            originalSenderId: sourceMessage.senderId,
            originalCreatedAt: sourceMessage.createdAt.toISOString(),
          },
        });
        const savedMessage = await manager.save(Message, message);

        // 3b. Copy attachment references (same storage keys — no file duplication)
        if (sourceMessage.attachments?.length > 0) {
          const attachments = sourceMessage.attachments.map((att) => {
            return manager.create(MessageAttachment, {
              messageId: savedMessage.id,
              messageCreatedAt: savedMessage.createdAt,
              storageKey: att.storageKey,
              originalFilename: att.originalFilename,
              mimeType: att.mimeType,
              fileSize: att.fileSize,
              width: att.width,
              height: att.height,
              durationSeconds: att.durationSeconds,
              thumbnailKey: att.thumbnailKey,
            });
          });
          await manager.save(MessageAttachment, attachments);
          savedMessage.attachments = attachments;
        }

        // 3c. Outbox event
        // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
        await this.outboxPublisher.enqueue({
          ...createBaseEvent('MessageForwarded', tenantId),
          channelId: targetChannelId,
          messageId: savedMessage.id,
          senderId: userId,
          sourceMessageId,
          sourceChannelId: sourceMessage.channelId,
          contentType: sourceMessage.contentType,
          createdAt: now.toISOString(),
        },  manager);

        return savedMessage;
      },
    );

    this.logger.debug(
      `Message forwarded: source=${sourceMessageId} -> target=${targetChannelId}, new=${forwardedMessage.id}`,
    );

    return forwardedMessage;
  }
}
