import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { v4 as uuidv4 } from 'uuid';

import { CreateChannelCommand } from './create-channel.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';
import { ChannelService } from '../services/channel.service';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';

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
  ) {}

  /**
   * Execute the create-channel command.
   *
   * - GROUP: requires MODULE_MANAGER+ platform role. Creator becomes OWNER.
   * - DIRECT: exactly 2 participants; de-duplicates via dmPairKey.
   * - AI: any authenticated user can create.
   */
  async execute(command: CreateChannelCommand): Promise<Channel> {
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

      // ---------------------------------------------------------------
      // Check for existing DM (return it instead of creating duplicate)
      // ---------------------------------------------------------------
      const existingDm = await this.dataSource
        .getRepository(Channel)
        .findOne({ where: { dmPairKey }, relations: ['members'] });

      if (existingDm) {
        this.logger.debug(
          `Returning existing DM channel ${existingDm.id} for pair ${dmPairKey}`,
        );
        return existingDm;
      }

      // Create DM inside transaction
      return this.createDirectChannel(tenantId, userId, peerIds, dmPairKey);
    }

    // GROUP or AI
    return this.createGroupOrAiChannel(tenantId, userId, input);
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const channel = queryRunner.manager.create(Channel, {
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
          channelId: savedChannel.id,
          userId: uid,
          role: ChannelMemberRole.MEMBER,
        }),
      );
      await queryRunner.manager.save(ChannelMember, members);

      // Outbox event
      await queryRunner.manager.save(
        queryRunner.manager.create(MessagingOutbox, {
          eventType: 'ChannelCreated',
          payload: {
            eventId: uuidv4(),
            tenantId,
            channelId: savedChannel.id,
            channelType: ChannelType.DIRECT,
            memberIds: peerIds,
          },
        }),
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Created DIRECT channel ${savedChannel.id}`);
      savedChannel.members = members;
      return savedChannel;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
  ): Promise<Channel> {
    // Ensure creator is included in member list
    const memberIds = [...new Set([creatorId, ...input.memberIds])];

    // TODO Phase 2: Validate all memberIds belong to same tenant via NATS request to auth-service.

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const channel = queryRunner.manager.create(Channel, {
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
      await queryRunner.manager.save(
        queryRunner.manager.create(MessagingOutbox, {
          eventType: 'ChannelCreated',
          payload: {
            eventId: uuidv4(),
            tenantId,
            channelId: savedChannel.id,
            channelType: input.type,
            memberIds,
          },
        }),
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Created ${input.type} channel ${savedChannel.id} with ${members.length} members`,
      );
      savedChannel.members = members;
      return savedChannel;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
