import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository, DataSource, In, IsNull, QueryRunner } from 'typeorm';

import { ChannelMember } from '../channel/entities/channel-member.entity';
import { LegalHoldService } from '../compliance/services/legal-hold.service';
import { Message } from '../message/entities/message.entity';
import { MessageContentType } from '../message/entities/message.entity';
import { MessageAttachment } from '../message/entities/message-attachment.entity';
import { MessageReceipt } from '../message/entities/message-receipt.entity';
import { ReceiptStatus } from '../message/entities/message-receipt.entity';
import { MediaService } from '../message/services/media.service';
import { PartitionManagerService } from '../partition/partition-manager.service';
import { REDIS_CLIENT } from '../shared/redis.provider';
import { toWireEnumName } from '../shared/enum-wire.util';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  GET_MESSAGE_FOR_BROADCAST_SUBJECT,
  type GetMessageForBroadcastRequest,
  type GetMessageForBroadcastResponse,
  type WsMessage,
  type WsMessageAttachment,
  type WsMessageContentType,
  type WsMessageReceipt,
  type WsReceiptStatus,
} from '@platform/event-contracts';

/** UUID representing an anonymised / deleted user. */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * SEC-M17: Strict canonical tenant schema name validation regex.
 *
 * NATS messages are internal but may originate from compromised containers.
 * Only the schema-manager canonical tenant_{first16_uuid_hex} format is accepted.
 * This prevents SQL injection via crafted schema names in NATS payloads.
 */
const TENANT_SCHEMA_REGEX = /^tenant_[0-9a-f]{16}$/;

/**
 * SEC-M17: Validate a tenant ID for use in SQL search_path.
 * Accepts only lowercase UUID v4 format to prevent injection.
 */
const TENANT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTIFICATION_REF_REGEX = TENANT_ID_REGEX;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function booleanColumn(rows: unknown, column: string): boolean {
  if (!Array.isArray(rows) || !isRecord(rows[0])) {
    return false;
  }
  return rows[0][column] === true;
}

function isMessageChannelRow(
  value: unknown,
): value is { id: string; channelId: string } {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['channelId'] === 'string'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface VerifyMembershipPayload {
  channelId: string;
  userId: string;
  tenantId: string;
}

interface GetChannelMembersPayload {
  channelId: string;
  tenantId: string;
}

interface GetMessageBatchPayload {
  messageIds: string[];
  tenantId: string;
}

interface UserDeletedPayload {
  deletedUserId: string;
  tenantId: string;
}

interface ResolveNotificationRefPayload {
  notificationRef: string;
  tenantId: string;
  userId: string;
}

interface NotificationRefRecord {
  tenantId: string;
  userId: string;
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
}

interface ResolveNotificationRefResult {
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
}

interface TenantProvisionedPayload {
  tenantId: string;
  schemaName: string;
}

interface ChannelMemberDto {
  userId: string;
  role: string;
  joinedAt: Date;
}

interface MessageBatchDto {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: string;
  createdAt: Date;
}

/**
 * NATS event/request handler for cross-service communication.
 *
 * Exposes request–reply endpoints consumed by notification-service and
 * ai-service, and reacts to domain events such as user deletion and
 * tenant provisioning.
 *
 * Every handler pins transaction-local PostgreSQL search_path to the tenant
 * schema before executing queries, ensuring tenant-isolated data access.
 */
@Controller()
export class MessagingNatsHandler {
  private readonly logger = new Logger(MessagingNatsHandler.name);

  constructor(
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly partitionManager: PartitionManagerService,
    // LegalHoldService injected for legal hold check in handleUserDeleted.
    // BEFORE: handleUserDeleted anonymized all messages with no hold check —
    // messages in litigation-held channels had their content wiped, destroying evidence.
    private readonly legalHoldService: LegalHoldService,
    // MediaService signs attachment download URLs when hydrating a message for
    // the gateway WS bridge (getMessageForBroadcast).
    private readonly mediaService: MediaService,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * SEC-M17: Pin the PostgreSQL search_path to the tenant schema for a transaction.
   *
   * Must be called before any tenant-scoped DB operation in NATS handlers,
   * because there is no HTTP middleware to set the schema automatically.
   * Validates tenant ID against strict UUID regex before interpolation to
   * prevent SQL injection via crafted NATS messages from compromised containers.
   *
   * @throws Error if tenantId does not match UUID v4 format
   */
  private async setTenantSchema(
    queryRunner: QueryRunner,
    tenantId: string,
  ): Promise<void> {
    if (!TENANT_ID_REGEX.test(tenantId)) {
      throw new Error(
        `SEC-M17: Invalid tenant ID format rejected: ${tenantId.substring(0, 50)}`,
      );
    }
    const schemaName = getTenantSchemaName(tenantId);
    await queryRunner.query(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"${schemaName}", "messaging", public`],
    );
  }

  private async withTenantQueryRunner<T>(
    tenantId: string,
    work: (queryRunner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.setTenantSchema(queryRunner, tenantId);
      const result = await work(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError: unknown) {
          this.logger.error(
            `Tenant NATS transaction rollback failed: ${errorMessage(rollbackError)}`,
          );
        }
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Verify that a user is an active member of a channel.
   * Used by the WebSocket gateway for join-room authorisation.
   */
  @MessagePattern('request.messaging.verifyMembership')
  async verifyMembership(
    @Payload() data: VerifyMembershipPayload,
  ): Promise<boolean> {
    return this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
      const member = await queryRunner.manager.findOne(ChannelMember, {
        where: {
          channelId: data.channelId,
          userId: data.userId,
          leftAt: IsNull(),
        },
      });
      return !!member;
    });
  }

  /**
   * Returns the list of active members for a given channel.
   * Used by notification-service to determine push-notification recipients.
   */
  @MessagePattern('request.messaging.getChannelMembers')
  async getChannelMembers(
    @Payload() data: GetChannelMembersPayload,
  ): Promise<ChannelMemberDto[]> {
    return this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
      const members = await queryRunner.manager.find(ChannelMember, {
        where: {
          channelId: data.channelId,
          leftAt: IsNull(),
        },
      });

      return members.map((m) => ({
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
      }));
    });
  }

  /**
   * Returns messages by IDs — used by ai-service for embedding generation.
   */
  @MessagePattern('request.messaging.getMessageBatch')
  async getMessageBatch(
    @Payload() data: GetMessageBatchPayload,
  ): Promise<MessageBatchDto[]> {
    if (!data.messageIds || data.messageIds.length === 0) return [];

    return this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
      const messages = await queryRunner.manager.find(Message, {
        where: { id: In(data.messageIds), isDeleted: false },
      });

      return messages.map((m) => ({
        id: m.id,
        channelId: m.channelId,
        senderId: m.senderId,
        content: m.content,
        contentType: m.contentType,
        createdAt: m.createdAt,
      }));
    });
  }

  /**
   * Hydrate one message into the full {@link WsMessage} the gateway WS bridge
   * broadcasts (MSG-CRITICAL-050). The NATS domain events are thin (IDs only)
   * per ADR-006; the bridge cannot emit a body the client can render without
   * this hydration step.
   *
   * SECURITY: the response carries `sender: { id }` ONLY — display PII
   * (name/avatar) is deliberately NOT exposed over NATS (auth-user-queries
   * profile-oracle constraint). The client enriches the sender from its
   * channel-members cache (loaded over the authorized GraphQL federation path).
   * Attachments carry tenant-scoped presigned URLs (the same isolation guard as
   * the GraphQL field resolver). Returns `{ message: null }` when the message is
   * absent in the tenant — the bridge then drops the broadcast.
   */
  @MessagePattern(GET_MESSAGE_FOR_BROADCAST_SUBJECT)
  async getMessageForBroadcast(
    @Payload() data: GetMessageForBroadcastRequest,
  ): Promise<GetMessageForBroadcastResponse> {
    if (
      !TENANT_ID_REGEX.test(data.tenantId) ||
      !TENANT_ID_REGEX.test(data.channelId) ||
      !TENANT_ID_REGEX.test(data.messageId)
    ) {
      this.logger.warn('Rejected getMessageForBroadcast with invalid id format');
      return { message: null };
    }

    return this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
      const message = await queryRunner.manager.findOne(Message, {
        where: { id: data.messageId, channelId: data.channelId, isDeleted: false },
      });
      if (!message) {
        return { message: null };
      }

      const [attachments, receipts] = await Promise.all([
        queryRunner.manager.find(MessageAttachment, {
          where: {
            tenantId: data.tenantId,
            messageId: message.id,
            messageCreatedAt: message.createdAt,
            isDeleted: false,
          },
          order: { createdAt: 'ASC' },
        }),
        queryRunner.manager.find(MessageReceipt, {
          where: {
            tenantId: data.tenantId,
            messageId: message.id,
            messageCreatedAt: message.createdAt,
          },
          order: { receiptCreatedAt: 'ASC' },
        }),
      ]);

      const wsAttachments: WsMessageAttachment[] = await Promise.all(
        attachments.map(async (a) => ({
          id: a.id,
          originalFilename: a.originalFilename,
          mimeType: a.mimeType,
          fileSize: Number(a.fileSize),
          width: a.width,
          height: a.height,
          durationSeconds: a.durationSeconds,
          downloadUrl: await this.safePresign(data.tenantId, a.storageKey),
          thumbnailUrl: await this.safePresign(data.tenantId, a.thumbnailKey),
        })),
      );

      const wsReceipts: WsMessageReceipt[] = receipts.map((r) => ({
        userId: r.userId,
        // Project the lowercase DB enum VALUE → UPPERCASE GraphQL enum NAME so
        // the live WS wire form matches the GraphQL query wire form exactly
        // (S1-CODEGEN). WsReceiptStatus IS the ReceiptStatus key union.
        status: toWireEnumName(ReceiptStatus, r.status) satisfies WsReceiptStatus,
        deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
        readAt: r.readAt ? r.readAt.toISOString() : null,
      }));

      const wsMessage: WsMessage = {
        id: message.id,
        channelId: message.channelId,
        senderId: message.senderId,
        content: message.content,
        // VALUE → NAME projection (see wsReceipts above). WsMessageContentType
        // IS the MessageContentType key union.
        contentType: toWireEnumName(
          MessageContentType,
          message.contentType,
        ) satisfies WsMessageContentType,
        parentId: message.parentId,
        forwardedFrom: message.forwardedFrom,
        isDeleted: message.isDeleted,
        createdAt: message.createdAt.toISOString(),
        editedAt: message.editedAt ? message.editedAt.toISOString() : null,
        metadata: message.metadata,
        idempotencyKey: message.idempotencyKey,
        sender: { id: message.senderId },
        attachments: wsAttachments,
        receipts: wsReceipts,
      };
      return { message: wsMessage };
    });
  }

  /** Presign a storage key, returning null on absence or a cross-tenant/transient failure. */
  private async safePresign(
    tenantId: string,
    storageKey: string | null,
  ): Promise<string | null> {
    if (!storageKey) {
      return null;
    }
    try {
      return await this.mediaService.generateDownloadUrl(tenantId, storageKey);
    } catch (error) {
      this.logger.warn(`Broadcast presign failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Resolve an opaque push notification ref after the mobile client is authenticated.
   *
   * Push payloads never carry channelId/messageId. The ref is stored under
   * tenant+recipient scope and consumed atomically, so wrong tenant/user lookups
   * miss without burning the real recipient's ref while valid double-click
   * replays fail after the first successful resolution.
   */
  @MessagePattern('request.messaging.resolveNotificationRef')
  async resolveNotificationRef(
    @Payload() data: ResolveNotificationRefPayload,
  ): Promise<ResolveNotificationRefResult | null> {
    if (
      !TENANT_ID_REGEX.test(data.tenantId) ||
      !TENANT_ID_REGEX.test(data.userId) ||
      !NOTIFICATION_REF_REGEX.test(data.notificationRef)
    ) {
      this.logger.warn('Rejected resolveNotificationRef with invalid tenant/user/ref format');
      return null;
    }

    const key = `msg:push:ref:${data.tenantId}:${data.userId}:${data.notificationRef}`;
    const raw = await this.consumeRedisKey(key);
    if (!raw) {
      return null;
    }

    let record: NotificationRefRecord;
    try {
      record = JSON.parse(raw) as NotificationRefRecord;
    } catch {
      this.logger.warn('Rejected malformed notificationRef record');
      return null;
    }

    if (
      record.tenantId !== data.tenantId ||
      record.userId !== data.userId ||
      !TENANT_ID_REGEX.test(record.channelId) ||
      !TENANT_ID_REGEX.test(record.messageId)
    ) {
      this.logger.warn('Rejected notificationRef with mismatched tenant/user or invalid target IDs');
      return null;
    }

    const messageCreatedAt = new Date(record.messageCreatedAt);
    if (Number.isNaN(messageCreatedAt.getTime())) {
      this.logger.warn('Rejected notificationRef with invalid messageCreatedAt');
      return null;
    }

    return this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
      const member = await queryRunner.manager.findOne(ChannelMember, {
        where: {
          channelId: record.channelId,
          userId: data.userId,
          leftAt: IsNull(),
        },
      });
      if (!member) {
        return null;
      }

      const messageRows: unknown = await queryRunner.query(
        `SELECT EXISTS(
           SELECT 1
           FROM messages
           WHERE id = $1
             AND "channelId" = $2
             AND "createdAt" = $3::timestamptz
             AND "isDeleted" = false
        ) AS exists`,
        [record.messageId, record.channelId, record.messageCreatedAt],
      );
      if (!booleanColumn(messageRows, 'exists')) {
        return null;
      }

      return {
        channelId: record.channelId,
        messageId: record.messageId,
        messageCreatedAt: record.messageCreatedAt,
      };
    });
  }

  /**
   * Handles user deletion: anonymises messages, removes channel memberships,
   * and cleans up reactions/receipts in a single transaction.
   * Pins tenant schema before executing any queries.
   */
  @EventPattern('events.*.UserDeleted')
  async handleUserDeleted(@Payload() data: UserDeletedPayload): Promise<void> {
    const deletedUserId = data.deletedUserId;
    if (!TENANT_ID_REGEX.test(data.tenantId) || !TENANT_ID_REGEX.test(deletedUserId)) {
      this.logger.error(
        'Rejected UserDeleted event missing canonical deletedUserId or valid tenantId',
      );
      return;
    }

    this.logger.log(
      `Processing UserDeleted for deletedUserId ${deletedUserId} in tenant ${data.tenantId}`,
    );

    try {
      await this.withTenantQueryRunner(data.tenantId, async (queryRunner) => {
        // SECURITY: Verify user has actual presence in claimed tenant before destructive cascade
        const userMessages: unknown = await queryRunner.query(
          `SELECT EXISTS(SELECT 1 FROM messages WHERE "senderId" = $1 LIMIT 1) AS has_messages`,
          [deletedUserId],
        );
        const userMemberships: unknown = await queryRunner.query(
          `SELECT EXISTS(SELECT 1 FROM channel_members WHERE "userId" = $1 LIMIT 1) AS has_memberships`,
          [deletedUserId],
        );

        if (
          !booleanColumn(userMessages, 'has_messages') &&
          !booleanColumn(userMemberships, 'has_memberships')
        ) {
          this.logger.log(
            `UserDeleted: deletedUserId=${deletedUserId} has no messaging footprint in tenant ${data.tenantId}, skipping cascade`,
          );
          return;
        }

        // Collect ALL message IDs for this user BEFORE any anonymization.
        // WHY: after we set senderId=ANONYMOUS_USER_ID, we can no longer identify
        // which messages belonged to this specific user — ANONYMOUS_USER_ID is shared
        // across all deleted users. We need the IDs up front to clean AI-derived tables.
        const userMsgRowsResult: unknown = await queryRunner.query(
          `SELECT id, "channelId" FROM messages WHERE "senderId" = $1`,
          [deletedUserId],
        );
        const userMsgRows = Array.isArray(userMsgRowsResult)
          ? userMsgRowsResult.filter(isMessageChannelRow)
          : [];
        const userMessageIds = userMsgRows.map((r) => r.id);

        // Determine which channels the user has messages in
        const channelRows = userMsgRows.reduce<Array<{ channelId: string }>>((acc, r) => {
          if (!acc.some((x) => x.channelId === r.channelId)) {
            acc.push({ channelId: r.channelId });
          }
          return acc;
        }, []);

        // For each channel, check legal hold status and anonymize accordingly.
        // BEFORE: all messages wiped unconditionally — messages in litigation-held
        // channels had content destroyed, creating spoliation liability.
        // WHY: Legal hold requires content preservation. We still anonymize the senderId
        // (to protect the user's identity under GDPR) but preserve content in held channels.
        const heldChannelIds = new Set<string>();
        for (const { channelId } of channelRows) {
          const isHeld = await this.legalHoldService.isUnderLegalHold(
            data.tenantId,
            channelId,
          );
          if (isHeld) {
            heldChannelIds.add(channelId);
            // Held channel: anonymize sender identity only, preserve content
            await queryRunner.query(
              `UPDATE messages SET "senderId" = $1 WHERE "senderId" = $2 AND "channelId" = $3`,
              [ANONYMOUS_USER_ID, deletedUserId, channelId],
            );
          }
        }

        // Non-held channels: anonymize sender + wipe content + clear embedding.
        // BEFORE: embedding column was NOT cleared — vector index retained the user's
        // original message content even after anonymization, enabling re-identification
        // via semantic similarity search. GdprService.anonymizeMyData() correctly
        // sets embedding=NULL; this handler now aligns with that behavior.
        if (heldChannelIds.size < channelRows.length) {
          const heldIds = Array.from(heldChannelIds);
          const whereClause = heldIds.length > 0
            ? `"senderId" = $2 AND "channelId" != ALL($3::uuid[])`
            : `"senderId" = $2`;
          const params = heldIds.length > 0
            ? [ANONYMOUS_USER_ID, deletedUserId, heldIds]
            : [ANONYMOUS_USER_ID, deletedUserId];

          await queryRunner.query(
            `UPDATE messages
             SET "senderId" = $1,
                 content = '[message deleted by user]',
                 embedding = NULL
             WHERE ${whereClause}`,
            params,
          );
        }

        // Clean AI-derived PII using the message IDs collected before anonymization.
        // BEFORE: message_entity_references and message_analysis rows were never cleaned.
        // Also: there was a bug where IDs were collected AFTER anonymization by querying
        // senderId=ANONYMOUS_USER_ID — which would return ALL anonymized users' messages.
        // Using pre-collected userMessageIds is the correct approach.
        if (userMessageIds.length > 0) {
          await queryRunner.query(
            `DELETE FROM message_entity_references WHERE "messageId" = ANY($1::uuid[])`,
            [userMessageIds],
          );
          await queryRunner.query(
            `DELETE FROM message_analysis WHERE "messageId" = ANY($1::uuid[])`,
            [userMessageIds],
          );
        }

        // Remove reactions
        await queryRunner.query(
          `DELETE FROM message_reactions WHERE "userId" = $1`,
          [deletedUserId],
        );

        // Remove receipts
        await queryRunner.query(
          `DELETE FROM message_receipts WHERE "userId" = $1`,
          [deletedUserId],
        );

        // Mark channel memberships as left
        await queryRunner.query(
          `UPDATE channel_members SET "leftAt" = NOW() WHERE "userId" = $1 AND "leftAt" IS NULL`,
          [deletedUserId],
        );
      });
      this.logger.log(`UserDeleted cascade completed for deletedUserId ${deletedUserId}`);
    } catch (err: unknown) {
      this.logger.error(
        `UserDeleted cascade failed for ${deletedUserId}: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * SEC-M17: When a new tenant is provisioned, create messaging partitions for its schema.
   *
   * Validates both tenantId (UUID) and schemaName (canonical tenant schema) from the
   * NATS payload before processing. Rejects payloads with invalid formats to prevent
   * SQL injection via crafted NATS messages from compromised containers.
   *
   * Subject shape (ORPHAN-HIGH-317 remediation): the publisher emits the
   * canonical 3-segment `events.{tenantId}.TenantProvisioned`
   * (NatsEventBus.deriveSubject). The previous 2-segment literal
   * `events.TenantProvisioned` could never match a 3-segment publish (NATS
   * matching is segment-exact — the ORPHAN-013 drift class), so this handler
   * had NEVER received a TenantProvisioned event.
   */
  @EventPattern('events.*.TenantProvisioned')
  async handleTenantProvisioned(
    @Payload() data: TenantProvisionedPayload,
  ): Promise<void> {
    // SEC-M17: Validate tenantId format
    if (!TENANT_ID_REGEX.test(data.tenantId)) {
      this.logger.error(
        `SEC-M17: Rejected TenantProvisioned with invalid tenantId: ${String(data.tenantId).substring(0, 50)}`,
      );
      return;
    }

    // SEC-M17: Validate schemaName format and tenant/schema binding.
    if (!TENANT_SCHEMA_REGEX.test(data.schemaName)) {
      this.logger.error(
        `SEC-M17: Rejected TenantProvisioned with invalid schemaName: ${String(data.schemaName).substring(0, 80)}`,
      );
      return;
    }
    const expectedSchemaName = getTenantSchemaName(data.tenantId);
    if (data.schemaName !== expectedSchemaName) {
      this.logger.error(
        `SEC-M17: Rejected TenantProvisioned with tenant/schema mismatch: ${data.tenantId}`,
      );
      return;
    }

    this.logger.log(
      `TenantProvisioned received — ensuring partitions for ${data.schemaName}`,
    );

    try {
      // Trigger partition creation via the partition manager's startup logic
      // which checks current + next 2 months
      await this.partitionManager.onApplicationBootstrap();
      this.logger.log(
        `Partitions ensured for tenant ${data.tenantId} (${data.schemaName})`,
      );
    } catch (err) {
      this.logger.error(
        `Partition creation failed for ${data.schemaName}: ${errorMessage(err)}`,
      );
    }
  }

  private async consumeRedisKey(key: string): Promise<string | null> {
    const result = await this.redis.multi().get(key).del(key).exec();
    if (!result) return null;

    const [getResult] = result;
    const [err, value] = getResult ?? [];
    if (err) {
      throw err;
    }
    return typeof value === 'string' ? value : null;
  }
}
