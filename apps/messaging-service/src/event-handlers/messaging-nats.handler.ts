import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull } from 'typeorm';
import {
  getTenantSchemaName,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { Message } from '../message/entities/message.entity';
import { PartitionManagerService } from '../partition/partition-manager.service';
import { LegalHoldService } from '../compliance/services/legal-hold.service';

/** UUID representing an anonymised / deleted user. */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * SEC-M17: Strict tenant schema name validation regex.
 *
 * NATS messages are internal but may originate from compromised containers.
 * Only 'public', 'messaging', or 'tenant_{uuid}' format is accepted.
 * This prevents SQL injection via crafted schema names in NATS payloads.
 */
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

/**
 * SEC-M17: Validate a tenant ID for use in SQL search_path.
 * Accepts only lowercase UUID v4 format to prevent injection.
 */
const TENANT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  userId?: string;
  deletedUserId?: string;
  tenantId: string;
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
 * Every handler sets the PostgreSQL search_path to the tenant schema
 * before executing queries, ensuring tenant-isolated data access.
 */
@Controller()
export class MessagingNatsHandler {
  private readonly logger = new Logger(MessagingNatsHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly partitionManager: PartitionManagerService,
    // LegalHoldService injected for legal hold check in handleUserDeleted.
    // BEFORE: handleUserDeleted anonymized all messages with no hold check —
    // messages in litigation-held channels had their content wiped, destroying evidence.
    private readonly legalHoldService: LegalHoldService,
  ) {}

  /**
   * Verify that a user is an active member of a channel.
   * Used by the WebSocket gateway for join-room authorisation.
   */
  @MessagePattern('request.messaging.verifyMembership')
  async verifyMembership(
    @Payload() data: VerifyMembershipPayload,
  ): Promise<boolean> {
    return runInTenantTransaction(this.dataSource, 'messaging', data.tenantId, async (queryRunner) => {
      const member = await queryRunner.manager.findOne(ChannelMember, {
        where: {
          tenantId: data.tenantId,
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
    return runInTenantTransaction(this.dataSource, 'messaging', data.tenantId, async (queryRunner) => {
      const members = await queryRunner.manager.find(ChannelMember, {
        where: {
          tenantId: data.tenantId,
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

    return runInTenantTransaction(this.dataSource, 'messaging', data.tenantId, async (queryRunner) => {
      const messages = await queryRunner.manager.find(Message, {
        where: { tenantId: data.tenantId, id: In(data.messageIds), isDeleted: false },
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
   * Handles user deletion: anonymises messages, removes channel memberships,
   * and cleans up reactions/receipts in a single transaction.
   * Sets tenant schema before executing any queries.
   */
  @EventPattern('events.*.UserDeleted')
  async handleUserDeleted(@Payload() data: UserDeletedPayload): Promise<void> {
    const deletedUserId = data.userId ?? data.deletedUserId;
    if (!deletedUserId || !TENANT_ID_REGEX.test(deletedUserId)) {
      this.logger.error(
        `SEC-M17: Rejected UserDeleted with invalid user id: ${String(deletedUserId).substring(0, 50)}`,
      );
      return;
    }

    this.logger.log(`Processing UserDeleted for user ${deletedUserId} in tenant ${data.tenantId}`);
    try {
      await runInTenantTransaction(this.dataSource, 'messaging', data.tenantId, async (queryRunner) => {
        // SECURITY: Verify user has actual presence in claimed tenant before destructive cascade
        const userMessages = await queryRunner.query(
          `SELECT EXISTS(
             SELECT 1 FROM messages
             WHERE "tenantId" = $1::uuid AND "senderId" = $2::uuid
             LIMIT 1
           ) AS has_messages`,
          [data.tenantId, deletedUserId],
        );
        const userMemberships = await queryRunner.query(
          `SELECT EXISTS(
             SELECT 1 FROM channel_members
             WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid
             LIMIT 1
           ) AS has_memberships`,
          [data.tenantId, deletedUserId],
        );

        if (!userMessages[0]?.has_messages && !userMemberships[0]?.has_memberships) {
          this.logger.log(
            `UserDeleted: userId=${deletedUserId} has no messaging footprint in tenant ${data.tenantId}, skipping cascade`,
          );
          return;
        }

        // Collect ALL message IDs for this user BEFORE any anonymization.
        // WHY: after we set senderId=ANONYMOUS_USER_ID, we can no longer identify
        // which messages belonged to this specific user — ANONYMOUS_USER_ID is shared
        // across all deleted users. We need the IDs up front to clean AI-derived tables.
        const userMsgRows: Array<{ id: string; channelId: string }> = await queryRunner.query(
          `SELECT id, "channelId"
           FROM messages
           WHERE "tenantId" = $1::uuid AND "senderId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );
        const userMessageIds = userMsgRows.map(r => r.id);

        // Determine which channels the user has messages in
        const channelRows = userMsgRows.reduce<Array<{ channelId: string }>>((acc, r) => {
          if (!acc.some(x => x.channelId === r.channelId)) acc.push({ channelId: r.channelId });
          return acc;
        }, []);

        // For each channel, check legal hold status and anonymize accordingly.
        // BEFORE: all messages wiped unconditionally — messages in litigation-held
        // channels had content destroyed, creating spoliation liability.
        // WHY: Legal hold requires content preservation. We still anonymize the senderId
        // (to protect the user's identity under GDPR) but preserve content in held channels.
        const heldChannelIds = new Set<string>();
        for (const { channelId } of channelRows) {
          const isHeld = await this.legalHoldService.isUnderLegalHold(data.tenantId, channelId);
          if (isHeld) {
            heldChannelIds.add(channelId);
            // Held channel: anonymize sender identity only, preserve content
            await queryRunner.query(
              `UPDATE messages
               SET "senderId" = $1
               WHERE "tenantId" = $2::uuid AND "senderId" = $3::uuid AND "channelId" = $4::uuid`,
              [ANONYMOUS_USER_ID, data.tenantId, deletedUserId, channelId],
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
            ? `"tenantId" = $2::uuid AND "senderId" = $3::uuid AND "channelId" != ALL($4::uuid[])`
            : `"tenantId" = $2::uuid AND "senderId" = $3::uuid`;
          const params = heldIds.length > 0
            ? [ANONYMOUS_USER_ID, data.tenantId, deletedUserId, heldIds]
            : [ANONYMOUS_USER_ID, data.tenantId, deletedUserId];

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
            `DELETE FROM message_entity_references
             WHERE "tenantId" = $1::uuid AND "messageId" = ANY($2::uuid[])`,
            [data.tenantId, userMessageIds],
          );
          await queryRunner.query(
            `DELETE FROM message_analysis
             WHERE "tenantId" = $1::uuid AND "messageId" = ANY($2::uuid[])`,
            [data.tenantId, userMessageIds],
          );
        }

        await queryRunner.query(
          `DELETE FROM message_reactions
           WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );

        await queryRunner.query(
          `DELETE FROM message_receipts
           WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );

        await queryRunner.query(
          `DELETE FROM message_read_receipt_keys
           WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );

        await queryRunner.query(
          `DELETE FROM message_send_idempotency
           WHERE "tenantId" = $1::uuid AND "senderId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );

        await queryRunner.query(
          `UPDATE channel_members
           SET "leftAt" = NOW()
           WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid AND "leftAt" IS NULL`,
          [data.tenantId, deletedUserId],
        );

        await queryRunner.query(
          `UPDATE tenant_principals
           SET "isActive" = false,
               "deactivatedAt" = COALESCE("deactivatedAt", NOW())
           WHERE "tenantId" = $1::uuid AND "userId" = $2::uuid`,
          [data.tenantId, deletedUserId],
        );
      });
      this.logger.log(`UserDeleted cascade completed for user ${deletedUserId}`);
    } catch (err) {
      this.logger.error(
        `UserDeleted cascade failed for ${deletedUserId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * SEC-M17: When a new tenant is provisioned, create messaging partitions for its schema.
   *
   * Validates both tenantId (UUID) and schemaName (tenant_{uuid} format) from the
   * NATS payload before processing. Rejects payloads with invalid formats to prevent
   * SQL injection via crafted NATS messages from compromised containers.
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

    // SEC-M17: Validate schemaName format and canonical tenantId mapping.
    if (!TENANT_SCHEMA_REGEX.test(data.schemaName) || data.schemaName !== getTenantSchemaName(data.tenantId)) {
      this.logger.error(
        `SEC-M17: Rejected TenantProvisioned with invalid schemaName: ${String(data.schemaName).substring(0, 80)}`,
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
        `Partition creation failed for ${data.schemaName}: ${(err as Error).message}`,
      );
    }
  }
}
