import {
  Injectable,
  Logger,
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
import { TenantUserAdmissionService } from '../services/tenant-user-admission.service';
import { createBaseEvent } from '@platform/event-contracts';
import { CreateChannelCommand } from './create-channel.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';
import { ChannelService } from '../services/channel.service';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';

// MSG-MEDIUM-070: GROUP creation is no longer role-gated. The product is
// WhatsApp-like — any tenant member may start a group, exactly as they may
// start a DM or an AI channel. Invited members are still validated as active
// users of THIS tenant (admissionService.assertActiveTenantUsers below), so
// opening group creation to members introduces no cross-tenant exposure.

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
    private readonly admissionService: TenantUserAdmissionService,
  ) {}

  /**
   * Execute the create-channel command.
   *
   * - GROUP: any tenant member may create (MSG-MEDIUM-070). Creator becomes OWNER.
   * - DIRECT: exactly 2 participants; de-duplicates via dmPairKey.
   * - AI: any authenticated user can create.
   */
  async execute(command: CreateChannelCommand): Promise<Channel> {
    return withTenantContext(command.tenantId, () => this.executeInTenantContext(command));
  }

  private async executeInTenantContext(command: CreateChannelCommand): Promise<Channel> {
    const { tenantId, userId, input } = command;

    // ---------------------------------------------------------------
    // Pre-validation
    // ---------------------------------------------------------------
    // MSG-MEDIUM-070: no GROUP role gate — any member may create a group
    // (WhatsApp-like). Member validity is enforced by the admission gate below.

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

      // Admission gate (DİLİM-2): the DM counterpart must be an active
      // user of this tenant — userId is the authenticated actor and is
      // excluded. channel.resolver.directChannel(targetUserId) accepts
      // an arbitrary UUID, so this is the only barrier against opening a
      // DM against another tenant's user. Fail-closed.
      await this.admissionService.assertActiveTenantUsers(
        tenantId,
        peerIds.filter((id) => id !== userId),
      );

      const dmPairKey = this.channelService.buildDmPairKey(peerIds[0], peerIds[1]);

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
    const channel = await this.createGroupOrAiChannel(tenantId, userId, input);
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
   * For AI channels, persists aiPersona from the input.
   * @see ADR-012 Phase 4 AI Persona system
   */
  private async createGroupOrAiChannel(
    tenantId: string,
    creatorId: string,
    input: CreateChannelCommand['input'],
  ): Promise<Channel> {
    // Ensure creator is included in member list
    const memberIds = [...new Set([creatorId, ...input.memberIds])];

    // Admission gate (DİLİM-2): every invited member must be an active
    // user of THIS tenant. creatorId is the authenticated actor — it is
    // proven by the gateway, so only the invited ids need validation.
    // Fail-closed: throws on any non-member / inactive / authority-down.
    await this.admissionService.assertActiveTenantUsers(
      tenantId,
      input.memberIds,
    );

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      // SECURITY: tenantId MUST be set on every channel row for RLS and event routing.
      const channel = queryRunner.manager.create(Channel, {
        tenantId,
        type: input.type,
        name: input.name ?? null,
        description: input.description ?? null,
        createdBy: creatorId,
        dmPairKey: null,
        aiPersona: input.type === ChannelType.AI ? (input.aiPersona ?? null) : null,
        // MSG-HIGH-060: aiServiceUrl removed — AI always routes through
        // ai-service over NATS with the tenant's BYOK key (no member-specified
        // endpoint, no exfiltration vector).
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
