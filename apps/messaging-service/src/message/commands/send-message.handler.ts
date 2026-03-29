import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException, Inject } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';

import { SendMessageCommand } from './send-message.command';
import { Message, MessageContentType } from '../entities/message.entity';
import { MessageAttachment } from '../entities/message-attachment.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { sanitizeContent, validateUrlSchemes } from '../../shared/sanitize';

/** Redis idempotency key TTL: 7 days */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Handler for SendMessageCommand — the most critical handler in the system.
 *
 * Flow:
 * 1. Check Redis idempotency key; if exists, return existing message (no duplicate)
 * 2. Sanitize content (strip HTML, validate URL schemes)
 * 3. Inside a single DB transaction: INSERT message + INSERT outbox event
 * 4. After transaction: SET Redis idempotency key with 7-day TTL
 * 5. Return created message
 */
@CommandHandler(SendMessageCommand)
export class SendMessageHandler implements ICommandHandler<SendMessageCommand, Message> {
  private readonly logger = new Logger(SendMessageHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(MessageAttachment)
    private readonly attachmentRepo: Repository<MessageAttachment>,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  async execute(command: SendMessageCommand): Promise<Message> {
    const {
      tenantId,
      senderId,
      channelId,
      content,
      contentType,
      idempotencyKey,
      parentId,
      attachmentKeys,
      metadata,
    } = command;

    // ── 1. Idempotency check ───────────────────────────────────────────
    const idemKey = `msg:${tenantId}:idem:${idempotencyKey}`;

    const existingMessageId = await this.safeRedisGet(idemKey);
    if (existingMessageId) {
      this.logger.debug(`Idempotent hit for key=${idempotencyKey}, returning existing message`);
      const existing = await this.messageRepo.findOne({
        where: { id: existingMessageId },
        relations: ['attachments'],
      });
      if (existing) {
        return existing;
      }
      // If message was deleted between idempotency set and now, fall through
      this.logger.warn(`Idempotent key exists but message ${existingMessageId} not found, proceeding`);
    }

    // ── 2. Content sanitization ────────────────────────────────────────
    let sanitizedContent: string | null = null;
    if (content !== null && content !== undefined) {
      sanitizedContent = sanitizeContent(content);

      if (!validateUrlSchemes(sanitizedContent)) {
        throw new BadRequestException(
          'Message content contains disallowed URL schemes. Only http:// and https:// are permitted.',
        );
      }
    }

    // Validate: TEXT messages must have content, others may have attachments only
    if (contentType === MessageContentType.TEXT && !sanitizedContent?.trim()) {
      throw new BadRequestException('Text messages must have non-empty content.');
    }

    // ── 3. Attachment validation ───────────────────────────────────────
    if (attachmentKeys.length > 0) {
      // TODO: Validate each storageKey exists in MinIO/S3 bucket.
      //       For each key, call S3 HeadObject to confirm upload completed.
      //       This prevents referencing non-existent files.
      this.logger.debug(`Attachment keys to validate: ${attachmentKeys.length}`);
    }

    // TODO: Magic byte verification for attachments via file-type package.
    //       After confirming storageKey exists, download first ~4KB of each file,
    //       use fileTypeFromBuffer() to verify the actual MIME matches declared MIME.
    //       Reject if mismatch to prevent disguised uploads (e.g., .exe as .jpg).

    // ── 4. Transactional insert: message + outbox ──────────────────────
    const messageId = uuidv4();
    const now = new Date();

    const createdMessage = await this.dataSource.transaction(async (manager) => {
      // 4a. INSERT message
      const message = manager.create(Message, {
        id: messageId,
        channelId,
        senderId,
        content: sanitizedContent,
        contentType,
        parentId: parentId ?? null,
        forwardedFrom: null,
        idempotencyKey,
        isDeleted: false,
        createdAt: now,
        editedAt: null,
        metadata: metadata ?? null,
      });
      const savedMessage = await manager.save(Message, message);

      // 4b. INSERT attachment records (if any)
      if (attachmentKeys.length > 0) {
        const attachments = attachmentKeys.map((storageKey) => {
          return manager.create(MessageAttachment, {
            messageId: savedMessage.id,
            messageCreatedAt: savedMessage.createdAt,
            storageKey,
            originalFilename: storageKey.split('/').pop() ?? 'unknown',
            mimeType: 'application/octet-stream', // TODO: resolve from upload metadata
            fileSize: 0, // TODO: resolve from upload metadata
          });
        });
        await manager.save(MessageAttachment, attachments);
        savedMessage.attachments = attachments;
      }

      // 4c. INSERT outbox event
      const outboxEvent = manager.create(MessagingOutbox, {
        eventType: 'MessageSent',
        payload: {
          eventId: uuidv4(),
          tenantId,
          channelId,
          messageId: savedMessage.id,
          senderId,
          contentType,
          hasAttachments: attachmentKeys.length > 0,
          createdAt: now.toISOString(),
        },
      });
      await manager.save(MessagingOutbox, outboxEvent);

      return savedMessage;
    });

    // ── 5. Set idempotency key in Redis (after successful transaction) ─
    await this.safeRedisSetEx(idemKey, IDEMPOTENCY_TTL_SECONDS, createdMessage.id);

    this.logger.debug(
      `Message created: id=${createdMessage.id}, channel=${channelId}, sender=${senderId}`,
    );

    return createdMessage;
  }

  /**
   * Safe Redis GET with graceful degradation.
   * Returns null if Redis is unavailable.
   */
  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis GET failed (proceeding without idempotency): ${message}`);
      return null;
    }
  }

  /**
   * Safe Redis SETEX with graceful degradation.
   */
  private async safeRedisSetEx(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.redis.setex(key, ttl, value);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis SETEX failed (idempotency key not stored): ${message}`);
    }
  }
}
