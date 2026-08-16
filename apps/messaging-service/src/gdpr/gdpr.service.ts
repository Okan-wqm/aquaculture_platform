import { randomUUID } from 'crypto';

import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  AUTH_CREDENTIAL_SUBJECTS,
  type GdprAnonymizeRequestedEvent,
  type UserDataAnonymizedEvent,
  type VerifyPasswordQuery,
} from '@platform/event-contracts';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Message } from '../message/entities/message.entity';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { LegalHoldDestructiveMutationAuthority } from '../compliance/services/legal-hold-destructive-mutation.authority';
import { ComplianceAction } from '../compliance/entities/compliance-audit-log.entity';
import { AttachmentObjectPurgeService } from '../compliance/services/attachment-object-purge.service';
import { MessagingMetricsService } from '../metrics/messaging-metrics.service';

/** UUID representing an anonymised / deleted user. */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Rate limit: 1 export every 24 hours per user. */
const EXPORT_COOLDOWN_SECONDS = 86400;

/** Timeout for cross-service NATS requests in ms. */
const NATS_TIMEOUT_MS = 10_000;

/**
 * GDPR Art 12(3) fulfilment window for cascaded erasure requests: data-subject
 * requests must be fulfilled without undue delay and within one month.
 * Carried on GdprAnonymizeRequestedEvent.fulfilByIso (ADR-044).
 */
const GDPR_FULFILMENT_WINDOW_DAYS = 30;

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly destructiveMutationAuthority: LegalHoldDestructiveMutationAuthority,
    private readonly metricsService: MessagingMetricsService,
    private readonly outboxPublisher: OutboxPublisher,
    // MSG-CRITICAL-058: the object-store arm of erasure — deletes the actual
    // MinIO attachment binaries whose DB rows anonymizeMyData removes.
    private readonly attachmentObjectPurge: AttachmentObjectPurgeService,
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
  async exportMyMessages(userId: string, tenantId: string): Promise<GdprExportResult> {
    // Rate-limit check
    const rateLimitKey = `msg:${tenantId}:gdpr:export:${userId}`;
    try {
      const alreadyRequested = await this.redis.get(rateLimitKey);
      if (alreadyRequested) {
        throw new BadRequestException('Data export can only be requested once every 24 hours');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`Redis rate-limit check failed, allowing export: ${(err as Error).message}`);
    }

    const { exportedMessages, memberships, receipts, reactions } = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const CHUNK_SIZE = 1000;
        const exportedMessages: ExportedMessage[] = [];
        let lastCursor: { createdAt: Date; id: string } | null = null;

        while (true) {
          let query = queryRunner.manager
            .createQueryBuilder(Message, 'm')
            .leftJoinAndSelect('m.attachments', 'a')
            .where('m."tenantId" = :tenantId', { tenantId })
            .andWhere('m."senderId" = :userId', { userId })
            .andWhere('m."isDeleted" = false')
            .orderBy('m.createdAt', 'ASC')
            .addOrderBy('m.id', 'ASC')
            .take(CHUNK_SIZE);

          if (lastCursor) {
            query = query.andWhere(
              '(m."createdAt" > :createdAt OR (m."createdAt" = :createdAt AND m."id" > :id))',
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

        const memberships: ExportedMembership[] = await queryRunner.query(
          `SELECT "channelId", role, "joinedAt", "leftAt"
           FROM channel_members
           WHERE "tenantId" = $1 AND "userId" = $2
           ORDER BY "joinedAt" ASC`,
          [tenantId, userId],
        );

        const receipts: ExportedReceipt[] = await queryRunner.query(
          `SELECT m."channelId", r."messageId", r."readAt"
           FROM message_receipts r
           INNER JOIN messages m ON m."tenantId" = r."tenantId" AND m.id = r."messageId"
           WHERE r."tenantId" = $1 AND r."userId" = $2
           ORDER BY r."readAt" ASC`,
          [tenantId, userId],
        );

        const reactions: ExportedReaction[] = await queryRunner.query(
          `SELECT "messageId", emoji, "createdAt"
           FROM message_reactions
           WHERE "tenantId" = $1 AND "userId" = $2
           ORDER BY "createdAt" ASC`,
          [tenantId, userId],
        );

        return { exportedMessages, memberships, receipts, reactions };
      },
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
   * 2. Deletes attachment DB rows.
   * 3. Deletes all read receipts for the user.
   * 4. Deletes all reactions by the user.
   * 5. Marks all channel memberships as left.
   *
   * After the transaction commits, purges the attachment MinIO objects captured
   * in step 2 (MSG-CRITICAL-058) so the binary PII is actually erased, not just
   * its DB row. Publishes `UserDataAnonymized` plus a `GdprAnonymizeRequested`
   * cascade event via the outbox — ai-service consumes the latter and erases its
   * own `agent_conversations` runner-context blob (ADR-044); messaging never
   * writes ai-service tables directly.
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

    // MSG-CRITICAL-058: collected inside the transaction (the storage + thumbnail
    // keys of the attachment rows about to be deleted) and purged from MinIO AFTER
    // the DB erasure commits. Declared here so it survives the transaction closure.
    const objectKeysToPurge: string[] = [];

    try {
      await this.destructiveMutationAuthority.runUserMutation(
        tenantId,
        userId,
        async ({ manager, heldChannelIds }) => {
          // IMPORTANT: Capture message IDs BEFORE anonymising senderId,
          // so we can delete attachments correctly. The locked hold snapshot is also
          // an SQL exclusion: a message concurrently created in a held channel can
          // never enter this erasure set.
          const userMessages: Array<{ id: string; createdAt: Date }> = await manager.query(
            `SELECT id, "createdAt" FROM messages
         WHERE "senderId" = $1
           AND NOT ("channelId" = ANY($2::uuid[]))`,
            [userId, heldChannelIds],
          );
          const messageIds = userMessages.map((m) => m.id);

          // 1. Delete all message_attachments for user's messages (before anonymising sender).
          // MSG-CRITICAL-058: capture the storage + thumbnail keys BEFORE the row delete
          // so the actual MinIO binaries (the PII) are purged after the transaction commits.
          if (messageIds.length > 0) {
            const attachmentRows: Array<{ storageKey: string; thumbnailKey: string | null }> =
              await manager.query(
                `SELECT "storageKey", "thumbnailKey" FROM message_attachments
             WHERE "messageId" = ANY($1::uuid[])`,
                [messageIds],
              );
            for (const row of attachmentRows) {
              objectKeysToPurge.push(row.storageKey);
              if (row.thumbnailKey) {
                objectKeysToPurge.push(row.thumbnailKey);
              }
            }

            await manager.query(
              `DELETE FROM message_attachments
           WHERE "messageId" = ANY($1::uuid[])`,
              [messageIds],
            );
          }

          // 2. Anonymise all messages (sender set to nil UUID, content replaced)
          await manager.query(
            `UPDATE messages
         SET "senderId" = $1,
             content = '[message deleted by user]',
             embedding = NULL
         WHERE "senderId" = $2
           AND NOT ("channelId" = ANY($3::uuid[]))`,
            [ANONYMOUS_USER_ID, userId, heldChannelIds],
          );

          // 3. Delete pinned_messages referencing user's messages
          if (messageIds.length > 0) {
            await manager.query(`DELETE FROM pinned_messages WHERE "messageId" = ANY($1::uuid[])`, [
              messageIds,
            ]);
          }

          // 4. Delete message_analysis for user's messages
          if (messageIds.length > 0) {
            await manager.query(
              `DELETE FROM message_analysis WHERE "messageId" = ANY($1::uuid[])`,
              [messageIds],
            );
          }

          // 5. Delete message_entity_references for user's messages
          if (messageIds.length > 0) {
            await manager.query(
              `DELETE FROM message_entity_references WHERE "messageId" = ANY($1::uuid[])`,
              [messageIds],
            );
          }

          // 6. Delete knowledge_entries whose source message belonged to the user.
          // WHY: knowledge_entries.sourceMessageId uses ON DELETE SET NULL so entries survive
          // message soft-delete. Must explicitly delete by sourceMessageId during GDPR erasure.
          if (messageIds.length > 0) {
            await manager.query(
              `DELETE FROM knowledge_entries WHERE "sourceMessageId" = ANY($1::uuid[])`,
              [messageIds],
            );
          }

          // 7. Delete all message_receipts for user
          await manager.query(
            `DELETE FROM message_receipts r
         USING messages m
         WHERE r."userId" = $1
           AND r."messageId" = m.id
           AND r."messageCreatedAt" = m."createdAt"
           AND NOT (m."channelId" = ANY($2::uuid[]))`,
            [userId, heldChannelIds],
          );

          // 8. Delete all message_reactions for user
          await manager.query(
            `DELETE FROM message_reactions r
         USING messages m
         WHERE r."userId" = $1
           AND r."messageId" = m.id
           AND r."messageCreatedAt" = m."createdAt"
           AND NOT (m."channelId" = ANY($2::uuid[]))`,
            [userId, heldChannelIds],
          );

          // 9. Mark all channel memberships as left
          await manager.query(
            `UPDATE channel_members
         SET "leftAt" = NOW()
         WHERE "userId" = $1
           AND "leftAt" IS NULL
           AND NOT ("channelId" = ANY($2::uuid[]))`,
            [userId, heldChannelIds],
          );

          // ── 10. Cascade anonymization to AgentConversation records (ai-service) ──
          // WHY (ADR-044 / INC-MSG-1): `agent_conversations` is ai-service-owned runner
          // working context; messaging.messages is the compliance owner of AI in-channel
          // content. The erasure crosses the service boundary by EVENT only — ai-service's
          // ConversationPrivacyEventHandler consumes GdprAnonymizeRequested and erases its
          // own blob. The former direct cross-service `UPDATE agent_conversations` (inside
          // a broad swallow-all catch) is removed: a cross-service SQL write violates
          // schema ownership and a swallowed failure faked coverage.
          //
          // Both events are enqueued INSIDE the erasure transaction, so a messaging-side
          // erasure can never commit without the cascade request being durably queued.
          // An enqueue failure is FAIL-LOUD: error log + metric + rethrow (transaction
          // rolls back). The outbox relay owns at-least-once delivery from here; the
          // ai-side delete is idempotent.
          const anonymizedAt = new Date().toISOString();
          // WHAT: requestId correlates the cascade across services; it is recorded in the
          // same-transaction compliance_audit_log row below, which is the request-of-record
          // for this self-service erasure flow (no shared.gdpr_data_requests row exists).
          const cascadeRequestId = randomUUID();
          // WHY: GDPR Art 12(3) grants one month to fulfil a data-subject request; the
          // event contract carries that obligation as fulfilByIso.
          const fulfilByIso = new Date(
            Date.now() + GDPR_FULFILMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString();
          // WHAT: both payloads are annotated with their contract types so the compiler
          // rejects missing/extra fields (the pre-fix emission shipped off-contract
          // fields and omitted required ones — schemas validate additionalProperties:false).
          const userDataAnonymizedEvent: UserDataAnonymizedEvent = {
            ...createBaseEvent<UserDataAnonymizedEvent>('UserDataAnonymized', tenantId),
            userId,
            method: 'pii-fields-nulled',
            initiatedBy: 'user',
          };
          // SECURITY: Cross-service cascade event for ai-service AgentConversation
          // cleanup (ADR-044).
          const gdprAnonymizeRequestedEvent: GdprAnonymizeRequestedEvent = {
            ...createBaseEvent<GdprAnonymizeRequestedEvent>('GdprAnonymizeRequested', tenantId),
            userId,
            requestId: cascadeRequestId,
            fulfilByIso,
          };
          try {
            await this.outboxPublisher.enqueue(userDataAnonymizedEvent, manager);
            await this.outboxPublisher.enqueue(gdprAnonymizeRequestedEvent, manager);
          } catch (error) {
            this.metricsService.incrementGdprCascadeEmitFailure(tenantId);
            this.logger.error(
              `GDPR erasure cascade event enqueue failed for user ${userId} (tenant ${tenantId}); ` +
                'rolling back erasure so no anonymisation commits without its cascade request',
            );
            throw error;
          }

          // 11. SECURITY: Compliance audit log INSIDE transaction (before commit)
          // BEFORE: audit log was written AFTER commit, so if audit write failed,
          // anonymization happened with no audit trail.
          await manager.query(
            `INSERT INTO compliance_audit_log ("tenantId", "userId", action, "resourceType", "resourceId", details, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
              tenantId,
              userId,
              ComplianceAction.DATA_ANONYMIZE,
              'user',
              userId,
              JSON.stringify({ anonymizedAt, cascadeRequestId, cascadeFulfilBy: fulfilByIso }),
            ],
          );
        },
      );

      // MSG-CRITICAL-058: the attachment ROWS are now committed-deleted; remove the
      // actual MinIO objects (the erasure's binary PII). Post-commit + best-effort:
      // a store failure is logged with the offending key and surfaced in the counts
      // but does NOT roll back the committed erasure — the row is gone, so the object
      // is unreferenceable and the residue is a storage leak a reaper finishes, not a
      // live PII reference. Tenant-prefix isolation is enforced inside purgeObjects.
      if (objectKeysToPurge.length > 0) {
        const purge = await this.attachmentObjectPurge.purgeObjects(tenantId, objectKeysToPurge);
        if (purge.failed > 0) {
          this.logger.error(
            `GDPR erasure: ${purge.failed}/${purge.requested} attachment object(s) failed to ` +
              `delete for user ${userId} (tenant ${tenantId}); orphaned PII objects require ` +
              `reaper/manual cleanup to complete erasure`,
          );
        } else {
          this.logger.log(
            `GDPR erasure: purged ${purge.deleted} attachment object(s) for user ${userId} ` +
              `(tenant ${tenantId}, ${purge.skipped} skipped)`,
          );
        }
      }

      // SECURITY: Increment GDPR erasure metric for compliance reporting.
      // @see MSG-HIGH-027 (GDPR erasure metric counter)
      this.metricsService.incrementGdprErasure(tenantId);

      this.logger.log(`GDPR anonymisation completed for user ${userId}`);

      return true;
    } catch (err) {
      this.logger.error(`GDPR anonymisation failed for user ${userId}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Verify the user's password by calling the auth-service via NATS request.
   */
  private async verifyPassword(userId: string, password: string): Promise<boolean> {
    try {
      const result = await firstValueFrom(
        this.natsClient
          .send<boolean, VerifyPasswordQuery>(AUTH_CREDENTIAL_SUBJECTS.VERIFY_PASSWORD, {
            userId,
            password,
          })
          .pipe(timeout(NATS_TIMEOUT_MS)),
      );
      // Bare boolean by contract: an RpcException (validation / rate-limit /
      // internal / no-responder-timeout) lands in the catch below and fails
      // closed — the irreversible erasure is blocked, never bypassed.
      return result === true;
    } catch (err) {
      this.logger.error(`Password verification request failed: ${(err as Error).message}`);
      throw new BadRequestException(
        'Unable to verify password at this time. Please try again later.',
      );
    }
  }
}
