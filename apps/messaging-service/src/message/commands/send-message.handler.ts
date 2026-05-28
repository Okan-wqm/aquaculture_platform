import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import {
  Logger,
  BadRequestException,
  ForbiddenException,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import Redis from 'ioredis';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { SendMessageCommand } from './send-message.command';
import { Message, MessageContentType } from '../entities/message.entity';
import { MessageAttachment } from '../entities/message-attachment.entity';
import { MessageSendIdempotency } from '../entities/message-send-idempotency.entity';
import { Channel } from '../../channel/entities/channel.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { TenantPrincipalService } from '../../principal/tenant-principal.service';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { sanitizeContent, validateUrlSchemes } from '../../shared/sanitize';
import { MentionService } from '../services/mention.service';
import { MediaService } from '../services/media.service';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';
import type { MentionableMember } from '../dto/mention.types';

/** Redis idempotency key TTL: 7 days */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Handler for SendMessageCommand — the most critical handler in the system.
 *
 * Flow:
 * 1. Redis is a cache only; DB idempotency is claimed after tenant authorization
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
    private readonly tenantPrincipalService: TenantPrincipalService,
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

    // ── 1. Fast cache lookup only; the DB claim below is authoritative ──
    const idemKey = `msg:${tenantId}:idem:${idempotencyKey}`;
    const cachedMessageId = await this.safeRedisGet(idemKey);
    if (cachedMessageId) {
      const cached = await runInTenantTransaction(
        this.dataSource,
        'messaging',
        tenantId,
        async (queryRunner) => queryRunner.manager.findOne(Message, {
          where: {
            tenantId,
            id: cachedMessageId,
            channelId,
            senderId,
          },
          relations: ['attachments'],
        }),
      );
      if (cached) {
        return cached;
      }
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

    const createdMessage = await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      let mentionedUserIds: string[] = [];

      const channel = await manager.findOne(Channel, {
        where: { tenantId, id: channelId },
      });
      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found.`);
      }
      if (channel.isArchived) {
        throw new BadRequestException('Cannot send messages to an archived channel.');
      }

      const senderMembership = await manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId: senderId, leftAt: IsNull() },
      });
      if (!senderMembership) {
        throw new ForbiddenException('You are not an active member of this channel.');
      }

      if (parentId) {
        const parent = await manager.findOne(Message, {
          where: { tenantId, id: parentId, channelId, isDeleted: false },
        });
        if (!parent) {
          throw new BadRequestException('Parent message must exist in the same channel.');
        }
      }

      await this.tenantPrincipalService.upsertActiveUsers(manager, tenantId, [senderId]);

      const claimRows = await manager.query(
        `INSERT INTO "message_send_idempotency"
           ("tenantId", "channelId", "senderId", "idempotencyKey", "messageId", "messageCreatedAt")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("tenantId", "channelId", "senderId", "idempotencyKey") DO NOTHING
         RETURNING "messageId", "messageCreatedAt"`,
        [tenantId, channelId, senderId, idempotencyKey, messageId, now],
      ) as Array<{ messageId: string; messageCreatedAt: Date }>;

      if (claimRows.length === 0) {
        const existingClaim = await manager.findOne(MessageSendIdempotency, {
          where: { tenantId, channelId, senderId, idempotencyKey },
        });
        if (existingClaim) {
          const existingMessage = await manager.findOne(Message, {
            where: {
              tenantId,
              id: existingClaim.messageId,
              createdAt: existingClaim.messageCreatedAt,
              channelId,
              senderId,
            },
            relations: ['attachments'],
          });
          if (existingMessage) {
            return existingMessage;
          }
        }
        throw new BadRequestException('Idempotency key is already in use.');
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
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelMessageSent', tenantId),
        channelId,
        messageId: savedMessage.id,
        senderId,
        contentType,
        hasAttachments: attachmentKeys.length > 0,
        mentionedUserIds: mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
        createdAt: now.toISOString(),
      },  manager);

      return savedMessage;
    });

    // ── 5. Set idempotency key in Redis (after successful transaction) ─
    await this.safeRedisSetEx(idemKey, IDEMPOTENCY_TTL_SECONDS, createdMessage.id);

    // ── 6. Record Prometheus metric ──────────────────────────────────────
    this.metricsService.incrementMessages(tenantId, contentType, 'unknown');

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
