import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import {
  runInTenantTransaction,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { CreateChannelCommand } from './create-channel.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';
import { ChannelService } from '../services/channel.service';
import { TenantUserAdmissionService } from '../services/tenant-user-admission.service';
import { TenantPrincipalService } from '../../principal/tenant-principal.service';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';

/** Platform roles that are allowed to create GROUP channels */
const GROUP_ALLOWED_ROLES = new Set([
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
]);

@Injectable()
@CommandHandler(CreateChannelCommand)
export class CreateChannelHandler
  implements ICommandHandler<CreateChannelCommand, Channel>
{
  private readonly logger = new Logger(CreateChannelHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly channelService: ChannelService,
    private readonly metricsService: MessagingMetricsService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tenantUserAdmissionService: TenantUserAdmissionService,
    private readonly tenantPrincipalService: TenantPrincipalService,
  ) {}

  /**
   * Execute the create-channel command.
   *
   * - GROUP: requires MODULE_MANAGER+ platform role. Creator becomes OWNER.
   * - DIRECT: exactly 2 participants; de-duplicates via dmPairKey.
   * - AI: any authenticated user can create.
   */
  async execute(command: CreateChannelCommand): Promise<Channel> {
    return withTenantContext(command.tenantId, () => this.executeInTenantContext(command));
  }

  private async executeInTenantContext(command: CreateChannelCommand): Promise<Channel> {
    const { tenantId, userId, input, userRole } = command;

    // ---------------------------------------------------------------
    // Pre-validation
    // ---------------------------------------------------------------
    if (input.type === ChannelType.GROUP && !GROUP_ALLOWED_ROLES.has(userRole)) {
      throw new ForbiddenException(
        'Only MODULE_MANAGER or higher roles can create GROUP channels',
      );
    }

    if (input.type === ChannelType.DIRECT) {
      // For DM the memberIds array must contain exactly the counterpart.
      // The creator is added automatically, so we expect 1 counterpart.
      // However the spec says "exactly 2 memberIds (1 is the creator)".
      // We accept either 1 (counterpart only) or 2 (including self).
      const uniqueIds = [...new Set(input.memberIds)];
      let peerIds: [string, string];

      if (uniqueIds.length === 2) {
        // Ensure creator is one of them
        if (!uniqueIds.includes(userId)) {
          throw new BadRequestException(
            'DIRECT channel memberIds must include the creator when providing 2 IDs',
          );
        }
        peerIds = [uniqueIds[0] as string, uniqueIds[1] as string];
      } else if (uniqueIds.length === 1) {
        const counterpart = uniqueIds[0] as string;
        if (counterpart === userId) {
          throw new BadRequestException(
            'Cannot create a DIRECT channel with yourself',
          );
        }
        peerIds = [userId, counterpart];
      } else {
        throw new BadRequestException(
          'DIRECT channel requires exactly 2 unique participants',
        );
      }

      const dmPairKey = this.channelService.buildDmPairKey(peerIds[0], peerIds[1]);
      await this.tenantUserAdmissionService.assertActiveTenantUsers(tenantId, peerIds);

      // ---------------------------------------------------------------
      // Check for existing DM (return it instead of creating duplicate).
      // The DataSource-scoped repo wraps via TenantScopedRepository so
      // the lookup auto-filters by tenantId — without this wrapper a
      // dmPairKey collision across tenants would silently return the
      // wrong tenant's DM (the entity's unique index on dmPairKey is
      // composite with tenantId; the original raw `where: { dmPairKey }`
      // relied on the index but did not enforce tenant filtering at the
      // ORM layer).
      const channelRepo = TenantScopedRepository.create(this.dataSource, Channel, tenantId);
      const existingDm = await channelRepo.findOne({
        where: { dmPairKey },
        relations: ['members'],
      });

      if (existingDm) {
        this.logger.debug(
          `Returning existing DM channel ${existingDm.id} for pair ${dmPairKey}`,
        );
        return existingDm;
      }

      // Create DM inside transaction
      const dmChannel = await this.createDirectChannel(tenantId, userId, peerIds, dmPairKey);
      this.metricsService.incrementChannelsCreated(tenantId, ChannelType.DIRECT);
      return dmChannel;
    }

    // GROUP or AI
    const memberIds = [...new Set([userId, ...input.memberIds])];
    await this.tenantUserAdmissionService.assertActiveTenantUsers(tenantId, memberIds);
    const channel = await this.createGroupOrAiChannel(tenantId, userId, input, memberIds);
    this.metricsService.incrementChannelsCreated(tenantId, input.type);
    return channel;
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  /**
   * Create a DIRECT (1-to-1) channel.
   */
  private async createDirectChannel(
    tenantId: string,
    creatorId: string,
    peerIds: string[],
    dmPairKey: string,
  ): Promise<Channel> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const existingDm = await queryRunner.manager.findOne(Channel, {
        where: { tenantId, dmPairKey },
        relations: ['members'],
      });

      if (existingDm) {
        this.logger.debug(
          `Returning existing DM channel ${existingDm.id} for pair ${dmPairKey}`,
        );
        return existingDm;
      }

      await this.tenantPrincipalService.upsertActiveUsers(queryRunner.manager, tenantId, peerIds);

      // SECURITY: tenantId MUST be set on every channel row for RLS and event routing.
      const channel = queryRunner.manager.create(Channel, {
        tenantId,
        type: ChannelType.DIRECT,
        name: null,
        description: null,
        createdBy: creatorId,
        dmPairKey,
      });
      const savedChannel = await queryRunner.manager.save(Channel, channel);

      // Both participants as MEMBER for DM
      const members = peerIds.map((uid) =>
        queryRunner.manager.create(ChannelMember, {
          tenantId,
          channelId: savedChannel.id,
          userId: uid,
          role: ChannelMemberRole.MEMBER,
        }),
      );
      await queryRunner.manager.save(ChannelMember, members);

      // Outbox event
      // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelCreated', tenantId),
        channelId: savedChannel.id,
        channelType: ChannelType.DIRECT,
        memberIds: peerIds,
      },  queryRunner.manager);

      this.logger.log(`Created DIRECT channel ${savedChannel.id}`);
      savedChannel.members = members;
      return savedChannel;
    });
  }

  /**
   * Create a GROUP or AI channel.
   * For AI channels, persists aiPersona and aiServiceUrl from the input.
   * @see ADR-012 Phase 4 AI Persona system
   */
  private async createGroupOrAiChannel(
    tenantId: string,
    creatorId: string,
    input: CreateChannelCommand['input'],
    memberIds: string[],
  ): Promise<Channel> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      await this.tenantPrincipalService.upsertActiveUsers(queryRunner.manager, tenantId, memberIds);

      // SECURITY: tenantId MUST be set on every channel row for RLS and event routing.
      const channel = queryRunner.manager.create(Channel, {
        tenantId,
        type: input.type,
        name: input.name ?? null,
        description: input.description ?? null,
        createdBy: creatorId,
        dmPairKey: null,
        aiPersona: input.type === ChannelType.AI ? (input.aiPersona ?? null) : null,
        aiServiceUrl: input.type === ChannelType.AI ? (input.aiServiceUrl ?? null) : null,
      });
      const savedChannel = await queryRunner.manager.save(Channel, channel);

      // Creator is OWNER, everyone else is MEMBER
      const members = memberIds.map((uid) =>
        queryRunner.manager.create(ChannelMember, {
          tenantId,
          channelId: savedChannel.id,
          userId: uid,
          role:
            uid === creatorId
              ? ChannelMemberRole.OWNER
              : ChannelMemberRole.MEMBER,
        }),
      );
      await queryRunner.manager.save(ChannelMember, members);

      // Outbox event
      // SECURITY: tenantId MUST be set at entity level for NATS subject routing.
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelCreated', tenantId),
        channelId: savedChannel.id,
        channelType: input.type,
        memberIds,
      },  queryRunner.manager);

      this.logger.log(
        `Created ${input.type} channel ${savedChannel.id} with ${members.length} members`,
      );
      savedChannel.members = members;
      return savedChannel;
    });
  }
}
