import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException, ConflictException, Inject } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import Redis from 'ioredis';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { SendMessageCommand } from './send-message.command';
import { Message, MessageContentType } from '../entities/message.entity';
import { MessageAttachment } from '../entities/message-attachment.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { sanitizeContent, validateUrlSchemes } from '../../shared/sanitize';
import { MentionService } from '../services/mention.service';
import { MediaService } from '../services/media.service';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';
import type { MentionableMember } from '../dto/mention.types';

/** Redis idempotency key TTL: 7 days */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SendMessageResult {
  message: Message;
  created: boolean;
}

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
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly mentionService: MentionService,
    private readonly mediaService: MediaService,
    private readonly metricsService: MessagingMetricsService,
    private readonly outboxPublisher: OutboxPublisher,
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

    // ── 1. Atomic idempotency check via SET NX ─────────────────────────
    const idemKey = `msg:${tenantId}:idem:${idempotencyKey}`;

    const wasSet = await this.safeRedisSetNx(idemKey, 'pending', IDEMPOTENCY_TTL_SECONDS);

    try {
      if (!wasSet) {
        this.logger.debug(`Idempotent hit for key=${idempotencyKey}, returning existing message`);
        const existingMessageId = await this.safeRedisGet(idemKey);
        if (existingMessageId && existingMessageId !== 'pending') {
          const existing = await runInTenantTransaction(
            this.dataSource,
            'messaging',
            tenantId,
            async (queryRunner) =>
              queryRunner.manager.findOne(Message, {
                where: { tenantId, id: existingMessageId },
                relations: ['attachments'],
              }),
          );
          if (existing) {
            return existing;
          }
        }
        this.logger.warn(`Idempotent key exists but message not found, consulting DB ledger`);
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

      // ── 2c. Voice note metadata ───────────────────────────────────────
      let voiceDurationSeconds: number | null = null;
      if (contentType === MessageContentType.VOICE) {
        voiceDurationSeconds = this.mediaService.extractVoiceDuration(metadata ?? null);
      }

      // Validate: TEXT messages must have content, others may have attachments only
      if (contentType === MessageContentType.TEXT && !sanitizedContent?.trim()) {
        throw new BadRequestException('Text messages must have non-empty content.');
      }

      // ── 3. Attachment validation ───────────────────────────────────────
      // Validate each key: tenant prefix isolation + HeadObject existence check.
      // Returns actual ContentLength and ContentType from MinIO metadata to replace
      // the 'application/octet-stream' / fileSize:0 placeholders.
      const attachmentMeta: Map<string, { contentLength: number; contentType: string }> = new Map();
      if (attachmentKeys.length > 0) {
        await Promise.all(
          attachmentKeys.map(async (key) => {
            const meta = await this.mediaService.validateAttachmentKey(tenantId, key);
            attachmentMeta.set(key, meta);
          }),
        );
      }

      // ── 4. Transactional insert: message + outbox ──────────────────────
      const messageId = uuidv4();
      const now = new Date();

      const result = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner): Promise<SendMessageResult> => {
          const { manager } = queryRunner;
          let mentionedUserIds: string[] = [];

          const existing = await this.reserveMessageIdempotency(manager, tenantId, idempotencyKey);
          if (existing) {
            return { message: existing, created: false };
          }

          if (sanitizedContent) {
            const members = await manager.find(ChannelMember, {
              where: { tenantId, channelId, leftAt: IsNull() },
              select: ['userId'],
            });

            // Build mentionable member list (userId + displayName).
            // 2026-05-02: Keep userId as the deterministic display identifier until
            // auth-service exposes a federated profile lookup owned by the messaging
            // read model. WHY: mention parsing must not call an ad-hoc remote lookup
            // from the write transaction path.
            const mentionableMembers: MentionableMember[] = members.map((m) => ({
              userId: m.userId,
              displayName: m.userId, // Placeholder until user resolution
            }));

            const mentionResult = this.mentionService.parseMentions(
              sanitizedContent,
              mentionableMembers,
            );
            sanitizedContent = mentionResult.processedContent;
            mentionedUserIds = mentionResult.mentionedUserIds;
          }

          // 4a. INSERT message
          // Build enriched metadata with mentions and voice duration
          const enrichedMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
          if (mentionedUserIds.length > 0) {
            enrichedMetadata['mentions'] = mentionedUserIds;
          }
          if (voiceDurationSeconds !== null) {
            enrichedMetadata['voiceDurationSeconds'] = voiceDurationSeconds;
          }

          // SECURITY: tenantId MUST be set on every message row for RLS and event routing.
          const message = manager.create(Message, {
            id: messageId,
            tenantId,
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
            metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : null,
          });
          const savedMessage = await manager.save(Message, message);

          // 4b. INSERT attachment records (if any)
          if (attachmentKeys.length > 0) {
            const attachments = attachmentKeys.map((storageKey) => {
              const meta = attachmentMeta.get(storageKey);
              return manager.create(MessageAttachment, {
                tenantId,
                messageId: savedMessage.id,
                messageCreatedAt: savedMessage.createdAt,
                storageKey,
                originalFilename: storageKey.split('/').pop() ?? 'unknown',
                mimeType: meta?.contentType ?? 'application/octet-stream',
                fileSize: meta?.contentLength ?? 0,
              });
            });
            await manager.save(MessageAttachment, attachments);
            savedMessage.attachments = attachments;
          }

          // 4c. INSERT outbox event
          // SECURITY: tenantId MUST be set at the entity level (not just inside payload)
          // for per-tenant NATS subject routing in the outbox worker.
          await this.outboxPublisher.enqueue(
            {
              ...createBaseEvent('MessageSent', tenantId),
              channelId,
              messageId: savedMessage.id,
              senderId,
              contentType,
              hasAttachments: attachmentKeys.length > 0,
              mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
              createdAt: now.toISOString(),
            },
            manager,
          );

          await this.bindMessageIdempotency(manager, tenantId, idempotencyKey, savedMessage);

          return { message: savedMessage, created: true };
        },
      );

      // ── 5. Set idempotency key in Redis (after successful transaction) ─
      await this.safeRedisSetEx(idemKey, IDEMPOTENCY_TTL_SECONDS, result.message.id);

      if (!result.created) {
        return result.message;
      }

      // ── 6. Record Prometheus metric ──────────────────────────────────────
      this.metricsService.incrementMessages(tenantId, contentType, 'unknown');

      this.logger.debug(
        `Message created: id=${result.message.id}, channel=${channelId}, sender=${senderId}`,
      );

      return result.message;
    } catch (err) {
      if (wasSet) {
        await this.safeRedisDel(idemKey);
      }
      throw err;
    }
  }

  private async reserveMessageIdempotency(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Message | null> {
    const reserved = (await manager.query(
      `INSERT INTO "message_idempotency_keys" ("tenantId", "idempotencyKey")
       VALUES ($1, $2)
       ON CONFLICT ("tenantId", "idempotencyKey") DO NOTHING
       RETURNING "tenantId"`,
      [tenantId, idempotencyKey],
    )) as Array<{ tenantId: string }>;

    if (reserved.length > 0) {
      return null;
    }

    const rows = (await manager.query(
      `SELECT "messageId", "messageCreatedAt"
       FROM "message_idempotency_keys"
       WHERE "tenantId" = $1 AND "idempotencyKey" = $2
       FOR UPDATE`,
      [tenantId, idempotencyKey],
    )) as Array<{ messageId: string | null; messageCreatedAt: Date | string | null }>;

    const existing = rows[0];
    if (!existing?.messageId) {
      throw new ConflictException('Message send with this idempotency key is already in progress.');
    }

    const message = await manager.findOne(Message, {
      where: { tenantId, id: existing.messageId },
      relations: ['attachments'],
    });
    if (!message) {
      throw new ConflictException('Message idempotency ledger points to a missing message.');
    }
    return message;
  }

  private async bindMessageIdempotency(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
    message: Message,
  ): Promise<void> {
    await manager.query(
      `UPDATE "message_idempotency_keys"
       SET "messageId" = $3,
           "messageCreatedAt" = $4,
           "updatedAt" = now()
       WHERE "tenantId" = $1 AND "idempotencyKey" = $2`,
      [tenantId, idempotencyKey, message.id, message.createdAt],
    );
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

  private async safeRedisDel(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis DEL failed for idempotency cleanup: ${message}`);
    }
  }

  /** Atomic SET NX with TTL for race-free idempotency. */
  private async safeRedisSetNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis SET NX failed (proceeding without idempotency): ${message}`);
      return true;
    }
  }
}
