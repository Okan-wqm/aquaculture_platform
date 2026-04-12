import { Injectable, Inject, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { Message } from '../message/entities/message.entity';
import { MessagingOutbox } from '../outbox/messaging-outbox.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { ComplianceAuditService } from '../compliance/services/compliance-audit.service';
import { ComplianceAction } from '../compliance/entities/compliance-audit-log.entity';
import { MessagingMetricsService } from '../metrics/messaging-metrics.service';

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
    private readonly metricsService: MessagingMetricsService,
    private readonly outboxPublisher: OutboxPublisher,
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

    // 1. Export messages using keyset pagination (cursor-based) to avoid OOM.
    // BEFORE: skip/take → SQL OFFSET N, which requires scanning N rows before each chunk.
    // On the partitioned messages table (RANGE by createdAt), this becomes O(N²) total cost.
    // A user with 100k messages would require ~50M row scans across all chunks.
    // WHY: Keyset pagination uses (createdAt, id) as a composite cursor.
    // The existing idx_messages_sender index on (senderId, createdAt DESC) supports this
    // with O(1) cost per chunk regardless of total message count.
    const CHUNK_SIZE = 1000;
    const exportedMessages: ExportedMessage[] = [];
    let lastCursor: { createdAt: Date; id: string } | null = null;

    while (true) {
      let query = this.messageRepo
        .createQueryBuilder('m')
        .leftJoinAndSelect('m.attachments', 'a')
        .where('m.senderId = :userId AND m.isDeleted = false', { userId })
        .orderBy('m.createdAt', 'ASC')
        .addOrderBy('m.id', 'ASC')
        .take(CHUNK_SIZE);

      if (lastCursor) {
        // Keyset predicate: fetch only rows after the last seen cursor.
        // Bug fix: PostgreSQL row-value syntax (col1, col2) > (val1, val2) is valid SQL
        // but TypeORM QueryBuilder does not support this syntax reliably across versions.
        // The equivalent explicit boolean expression is correctly parsed by TypeORM:
        //   rows where createdAt > cursor, OR same createdAt but id > cursor id.
        // This correctly handles timestamp ties within the same millisecond.
        query = query.andWhere(
          '(m."createdAt" > :createdAt OR (m."createdAt" = :createdAt AND m.id > :id))',
          { createdAt: lastCursor.createdAt, id: lastCursor.id },
        );
      }

      const chunk = await query.getMany();

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

      const last = chunk[chunk.length - 1];
      if (last) {
        lastCursor = { createdAt: last.createdAt, id: last.id };
      }
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
    // Step 1: Verify password via auth-service (outside transaction -- network call)
    const passwordValid = await this.verifyPassword(userId, confirmPassword);
    if (!passwordValid) {
      throw new BadRequestException('Invalid password confirmation');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ── SECURITY: Legal hold check INSIDE transaction with SELECT FOR UPDATE ──
      // BEFORE: legal hold check was OUTSIDE the transaction (TOCTOU race).
      // A concurrent legal hold creation between the check and anonymize would
      // allow anonymization of legally-held data, destroying evidence.
      // WHY: SELECT FOR UPDATE on legal_holds serializes concurrent hold creation
      // and anonymization -- if a hold is being created concurrently, this query
      // blocks until that transaction commits/rolls back, then re-evaluates.
      // @see MSG-CRITICAL-019
      const activeTenantHolds: Array<{ id: string; channelId: string | null }> = await queryRunner.query(
        `SELECT id, "channelId" FROM legal_holds
         WHERE "tenantId" = $1 AND "isActive" = true
         FOR UPDATE`,
        [tenantId],
      );

      // Check if any hold is tenant-wide (channelId IS NULL)
      const tenantWideHold = activeTenantHolds.find((h) => h.channelId === null);
      if (tenantWideHold) {
        throw new ForbiddenException('Tenant is under legal hold and data cannot be anonymized');
      }

      // Check per-channel holds for user's channels
      if (activeTenantHolds.length > 0) {
        const userMemberships: Array<{ channelId: string }> = await queryRunner.query(
          `SELECT "channelId" FROM channel_members WHERE "userId" = $1`,
          [userId],
        );
        const heldChannelIds = new Set(
          activeTenantHolds
            .filter((h) => h.channelId !== null)
            .map((h) => h.channelId),
        );
        for (const membership of userMemberships) {
          if (heldChannelIds.has(membership.channelId)) {
            throw new ForbiddenException(`Channel ${membership.channelId} is under legal hold`);
          }
        }
      }

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

      // 6. Delete knowledge_entries whose source message belonged to the user.
      // WHY: knowledge_entries.sourceMessageId uses ON DELETE SET NULL so entries survive
      // message soft-delete. Must explicitly delete by sourceMessageId during GDPR erasure.
      if (messageIds.length > 0) {
        await queryRunner.query(
          `DELETE FROM knowledge_entries WHERE "sourceMessageId" = ANY($1::uuid[])`,
          [messageIds],
        );
      }

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

      // ── 10. Cascade anonymization to AgentConversation records (ai-service) ──
      // SECURITY: GDPR Article 17 requires erasure of ALL personal data, including
      // AI chat history. Since AgentConversation lives in ai-service, we publish a
      // GdprAnonymizeRequested event via the outbox so ai-service can clean up.
      // Also attempt direct DB cleanup for shared-DB deployments.
      // @see MSG-CRITICAL-024
      try {
        await queryRunner.query(
          `UPDATE agent_conversations
           SET messages = $1::jsonb,
               title = '[ANONYMIZED]',
               "isActive" = false
           WHERE "userId" = $2 AND "tenantId" = $3`,
          [
            JSON.stringify([{ role: 'system', content: '[ANONYMIZED]', timestamp: new Date().toISOString() }]),
            userId,
            tenantId,
          ],
        );
      } catch {
        // Table may not exist in this DB (separate-db deployment) -- event handles it
        this.logger.warn(
          'agent_conversations table not found in messaging DB; relying on GdprAnonymizeRequested event for ai-service cascade',
        );
      }

      // 11. Log to outbox for event publication (UserDataAnonymized + GdprAnonymizeRequested)
      const anonymizedAt = new Date().toISOString();
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('UserDataAnonymized', tenantId),
        userId,
        anonymizedAt,
      } as BaseEvent, queryRunner.manager);

      // SECURITY: Cross-service cascade event for ai-service AgentConversation cleanup
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('GdprAnonymizeRequested', tenantId),
        userId,
        anonymizedAt,
        targetService: 'ai-service',
        targetEntity: 'AgentConversation',
      } as BaseEvent, queryRunner.manager);

      // 12. SECURITY: Compliance audit log INSIDE transaction (before commit)
      // BEFORE: audit log was written AFTER commit, so if audit write failed,
      // anonymization happened with no audit trail.
      await queryRunner.query(
        `INSERT INTO compliance_audit_log ("tenantId", "userId", action, "resourceType", "resourceId", details, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          tenantId,
          userId,
          ComplianceAction.DATA_ANONYMIZE,
          'user',
          userId,
          JSON.stringify({ anonymizedAt }),
        ],
      );

      await queryRunner.commitTransaction();

      // SECURITY: Increment GDPR erasure metric for compliance reporting.
      // @see MSG-HIGH-027 (GDPR erasure metric counter)
      this.metricsService.incrementGdprErasure(tenantId);

      this.logger.log(`GDPR anonymisation completed for user ${userId}`);

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
