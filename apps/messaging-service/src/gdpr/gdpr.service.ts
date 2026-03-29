import { Injectable, Inject, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';
import { Message } from '../message/entities/message.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { ComplianceAuditService } from '../compliance/services/compliance-audit.service';
import { ComplianceAction } from '../compliance/entities/compliance-audit-log.entity';

/** UUID representing an anonymised / deleted user. */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Rate limit: 1 export every 24 hours per user. */
const EXPORT_COOLDOWN_SECONDS = 86400;

/** Timeout for cross-service NATS requests in ms. */
const NATS_TIMEOUT_MS = 10_000;

interface ExportedMessage {
  content: string | null;
  createdAt: Date;
  channelId: string;
  contentType: string;
  attachments: Array<{
    originalFilename: string;
    mimeType: string;
    fileSize: number;
  }>;
}

/** Channel membership record for GDPR export. */
interface ExportedMembership {
  channelId: string;
  role: string;
  joinedAt: Date;
  leftAt: Date | null;
}

/** Read receipt record for GDPR export. */
interface ExportedReceipt {
  channelId: string;
  messageId: string;
  readAt: Date;
}

/** Reaction record for GDPR export. */
interface ExportedReaction {
  messageId: string;
  emoji: string;
  createdAt: Date;
}

/** Full GDPR data export result. */
interface GdprExportResult {
  messages: ExportedMessage[];
  channelMemberships: ExportedMembership[];
  readReceipts: ExportedReceipt[];
  reactions: ExportedReaction[];
}

interface VerifyPasswordPayload {
  userId: string;
  password: string;
}

/**
 * GDPR compliance service for the messaging domain.
 *
 * Provides data portability (export) and right-to-erasure (anonymisation)
 * capabilities as required by GDPR Articles 17 and 20.
 */
@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(MessagingOutbox)
    private readonly outboxRepo: Repository<MessagingOutbox>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly legalHoldService: LegalHoldService,
    private readonly complianceAuditService: ComplianceAuditService,
  ) {}

  /**
   * Export all messages authored by the user as a JSON-serializable array.
   *
   * Includes content, timestamps, channel, content type, and attachment
   * metadata (filename, mime, size). Binary data is excluded.
   *
   * Rate-limited to 1 request per 24 hours per user via Redis.
   */
  /**
   * Export all user data in the messaging domain as a JSON-serializable structure.
   *
   * Includes:
   * - Messages (content, timestamps, channel, content type, attachment metadata)
   * - Channel memberships (role, join/leave dates)
   * - Read receipts
   * - Reactions
   *
   * Rate-limited to 1 request per 24 hours per user via Redis.
   */
  async exportMyMessages(
    userId: string,
    tenantId: string,
  ): Promise<GdprExportResult> {
    // Rate-limit check
    const rateLimitKey = `msg:${tenantId}:gdpr:export:${userId}`;
    try {
      const alreadyRequested = await this.redis.get(rateLimitKey);
      if (alreadyRequested) {
        throw new BadRequestException(
          'Data export can only be requested once every 24 hours',
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`Redis rate-limit check failed, allowing export: ${(err as Error).message}`);
    }

    // 1. Export messages using chunked pagination to avoid OOM
    const CHUNK_SIZE = 1000;
    let exportOffset = 0;
    const exportedMessages: ExportedMessage[] = [];
    while (true) {
      const chunk = await this.messageRepo.find({
        where: { senderId: userId, isDeleted: false },
        relations: ['attachments'],
        order: { createdAt: 'ASC' },
        take: CHUNK_SIZE,
        skip: exportOffset,
      });
      for (const msg of chunk) {
        exportedMessages.push({
          content: msg.content,
          createdAt: msg.createdAt,
          channelId: msg.channelId,
          contentType: msg.contentType,
          attachments: (msg.attachments ?? []).map((att) => ({
            originalFilename: att.originalFilename,
            mimeType: att.mimeType,
            fileSize: att.fileSize,
          })),
        });
      }
      if (chunk.length < CHUNK_SIZE) break;
      exportOffset += CHUNK_SIZE;
    }

    // 2. Export channel memberships
    const memberships: ExportedMembership[] = await this.dataSource.query(
      `SELECT "channelId", role, "joinedAt", "leftAt" FROM channel_members WHERE "userId" = $1 ORDER BY "joinedAt" ASC`,
      [userId],
    );

    // 3. Export read receipts
    const receipts: ExportedReceipt[] = await this.dataSource.query(
      `SELECT "channelId", "messageId", "readAt" FROM message_receipts WHERE "userId" = $1 ORDER BY "readAt" ASC`,
      [userId],
    );

    // 4. Export reactions
    const reactions: ExportedReaction[] = await this.dataSource.query(
      `SELECT "messageId", emoji, "createdAt" FROM message_reactions WHERE "userId" = $1 ORDER BY "createdAt" ASC`,
      [userId],
    );

    // Set rate-limit key after successful export
    try {
      await this.redis.set(rateLimitKey, '1', 'EX', EXPORT_COOLDOWN_SECONDS);
    } catch (err) {
      this.logger.warn(`Failed to set export rate-limit key: ${(err as Error).message}`);
    }

    this.logger.log(
      `GDPR export completed for user ${userId}: ${exportedMessages.length} messages, ${memberships.length} memberships, ${receipts.length} receipts, ${reactions.length} reactions`,
    );

    return {
      messages: exportedMessages,
      channelMemberships: memberships,
      readReceipts: receipts,
      reactions,
    };
  }

  /**
   * Anonymise all user data in the messaging domain.
   *
   * Requires password confirmation via the auth-service before proceeding.
   * Performs the following in a single database transaction:
   * 1. Anonymises all messages (sender set to nil UUID, content replaced).
   * 2. Deletes attachment DB rows (and MinIO objects if applicable).
   * 3. Deletes all read receipts for the user.
   * 4. Deletes all reactions by the user.
   * 5. Marks all channel memberships as left.
   *
   * Publishes a `UserDataAnonymized` event via the outbox.
   *
   * @returns `true` on success.
   */
  async anonymizeMyData(
    userId: string,
    tenantId: string,
    confirmPassword: string,
  ): Promise<boolean> {
    // Step 0: Per-channel legal hold check
    const userMemberships: Array<{ channelId: string }> = await this.dataSource.query(
      `SELECT "channelId" FROM channel_members WHERE "userId" = $1`,
      [userId],
    );
    const isTenantUnderHold = await this.legalHoldService.isUnderLegalHold(tenantId, null);
    if (isTenantUnderHold) {
      throw new ForbiddenException('Tenant is under legal hold and data cannot be anonymized');
    }
    for (const membership of userMemberships) {
      if (await this.legalHoldService.isUnderLegalHold(tenantId, membership.channelId)) {
        throw new ForbiddenException(`Channel ${membership.channelId} is under legal hold`);
      }
    }

    // Step 1: Verify password via auth-service
    const passwordValid = await this.verifyPassword(userId, confirmPassword);
    if (!passwordValid) {
      throw new BadRequestException('Invalid password confirmation');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // IMPORTANT: Capture message IDs BEFORE anonymising senderId,
      // so we can delete attachments correctly.
      const userMessages: Array<{ id: string; createdAt: Date }> = await queryRunner.query(
        `SELECT id, "createdAt" FROM messages WHERE "senderId" = $1`,
        [userId],
      );
      const messageIds = userMessages.map((m) => m.id);

      // 1. Delete all message_attachments for user's messages (before anonymising sender)
      if (messageIds.length > 0) {
        await queryRunner.query(
          `DELETE FROM message_attachments
           WHERE "messageId" = ANY($1::uuid[])`,
          [messageIds],
        );
      }

      // 2. Anonymise all messages (sender set to nil UUID, content replaced)
      await queryRunner.query(
        `UPDATE messages
         SET "senderId" = $1,
             content = '[message deleted by user]',
             embedding = NULL
         WHERE "senderId" = $2`,
        [ANONYMOUS_USER_ID, userId],
      );

      // 3. Delete pinned_messages referencing user's messages
      if (messageIds.length > 0) {
        await queryRunner.query(
          `DELETE FROM pinned_messages WHERE "messageId" = ANY($1::uuid[])`,
          [messageIds],
        );
      }

      // 4. Delete message_analysis for user's messages
      if (messageIds.length > 0) {
        await queryRunner.query(
          `DELETE FROM message_analysis WHERE "messageId" = ANY($1::uuid[])`,
          [messageIds],
        );
      }

      // 5. Delete message_entity_references for user's messages
      if (messageIds.length > 0) {
        await queryRunner.query(
          `DELETE FROM message_entity_references WHERE "messageId" = ANY($1::uuid[])`,
          [messageIds],
        );
      }

      // 6. Delete knowledge_entries authored by the user
      await queryRunner.query(
        `DELETE FROM knowledge_entries WHERE "authorId" = $1`,
        [userId],
      );

      // 7. Delete all message_receipts for user
      await queryRunner.query(
        `DELETE FROM message_receipts WHERE "userId" = $1`,
        [userId],
      );

      // 8. Delete all message_reactions for user
      await queryRunner.query(
        `DELETE FROM message_reactions WHERE "userId" = $1`,
        [userId],
      );

      // 9. Mark all channel memberships as left
      await queryRunner.query(
        `UPDATE channel_members
         SET "leftAt" = NOW()
         WHERE "userId" = $1 AND "leftAt" IS NULL`,
        [userId],
      );

      // 10. Log to outbox for event publication
      await queryRunner.query(
        `INSERT INTO messaging_outbox ("eventType", payload, "createdAt")
         VALUES ($1, $2, NOW())`,
        [
          'UserDataAnonymized',
          JSON.stringify({ userId, tenantId, anonymizedAt: new Date().toISOString() }),
        ],
      );

      await queryRunner.commitTransaction();
      this.logger.log(`GDPR anonymisation completed for user ${userId}`);

      // Log anonymisation to compliance audit
      await this.complianceAuditService.log({
        tenantId,
        userId,
        action: ComplianceAction.DATA_ANONYMIZE,
        resourceType: 'user',
        resourceId: userId,
        details: { anonymizedAt: new Date().toISOString() },
        ipAddress: null,
        userAgent: null,
      });

      return true;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `GDPR anonymisation failed for user ${userId}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Verify the user's password by calling the auth-service via NATS request.
   */
  private async verifyPassword(
    userId: string,
    password: string,
  ): Promise<boolean> {
    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<boolean, VerifyPasswordPayload>('request.auth.verifyPassword', {
            userId,
            password,
          })
          .pipe(timeout(NATS_TIMEOUT_MS)),
      );
      return !!result;
    } catch (err) {
      this.logger.error(
        `Password verification request failed: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        'Unable to verify password at this time. Please try again later.',
      );
    }
  }
}
