import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, In, IsNull } from 'typeorm';
import { ChannelMember } from '../channel/entities/channel-member.entity';
import { Message } from '../message/entities/message.entity';
import { PartitionManagerService } from '../partition/partition-manager.service';

/** UUID representing an anonymised / deleted user. */
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

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
  userId: string;
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
  ) {}

  /**
   * Verify that a user is an active member of a channel.
   * Used by the WebSocket gateway for join-room authorisation.
   */
  @MessagePattern('request.messaging.verifyMembership')
  async verifyMembership(
    @Payload() data: VerifyMembershipPayload,
  ): Promise<boolean> {
    const member = await this.memberRepo.findOne({
      where: {
        channelId: data.channelId,
        userId: data.userId,
        leftAt: IsNull(),
      },
    });
    return !!member;
  }

  /**
   * Returns the list of active members for a given channel.
   * Used by notification-service to determine push-notification recipients.
   */
  @MessagePattern('request.messaging.getChannelMembers')
  async getChannelMembers(
    @Payload() data: GetChannelMembersPayload,
  ): Promise<ChannelMemberDto[]> {
    const members = await this.memberRepo.find({
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
  }

  /**
   * Returns messages by IDs — used by ai-service for embedding generation.
   */
  @MessagePattern('request.messaging.getMessageBatch')
  async getMessageBatch(
    @Payload() data: GetMessageBatchPayload,
  ): Promise<MessageBatchDto[]> {
    if (!data.messageIds || data.messageIds.length === 0) return [];

    const messages = await this.messageRepo.find({
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
  }

  /**
   * Handles user deletion: anonymises messages, removes channel memberships,
   * and cleans up reactions/receipts in a single transaction.
   */
  @EventPattern('events.UserDeleted')
  async handleUserDeleted(@Payload() data: UserDeletedPayload): Promise<void> {
    this.logger.log(`Processing UserDeleted for user ${data.userId}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Anonymise messages
      await queryRunner.query(
        `UPDATE messages
         SET "senderId" = $1,
             content = '[message deleted by user]'
         WHERE "senderId" = $2`,
        [ANONYMOUS_USER_ID, data.userId],
      );

      // Remove reactions
      await queryRunner.query(
        `DELETE FROM message_reactions WHERE "userId" = $1`,
        [data.userId],
      );

      // Remove receipts
      await queryRunner.query(
        `DELETE FROM message_receipts WHERE "userId" = $1`,
        [data.userId],
      );

      // Mark channel memberships as left
      await queryRunner.query(
        `UPDATE channel_members SET "leftAt" = NOW() WHERE "userId" = $1 AND "leftAt" IS NULL`,
        [data.userId],
      );

      await queryRunner.commitTransaction();
      this.logger.log(`UserDeleted cascade completed for user ${data.userId}`);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `UserDeleted cascade failed for ${data.userId}: ${(err as Error).message}`,
      );
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * When a new tenant is provisioned, create messaging partitions for its schema.
   */
  @EventPattern('events.TenantProvisioned')
  async handleTenantProvisioned(
    @Payload() data: TenantProvisionedPayload,
  ): Promise<void> {
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
