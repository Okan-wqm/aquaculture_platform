import {
  Injectable,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { AddMemberCommand } from './add-member.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';

/**
 * Role hierarchy weight — higher number = more privileged.
 */
const ROLE_WEIGHT: Record<ChannelMemberRole, number> = {
  [ChannelMemberRole.MEMBER]: 0,
  [ChannelMemberRole.ADMIN]: 1,
  [ChannelMemberRole.OWNER]: 2,
};

/**
 * Maximum role each actor role can assign (ADR-012 section 6.5):
 * - OWNER  -> can assign MEMBER, ADMIN, OWNER
 * - ADMIN  -> can assign MEMBER, ADMIN (NOT OWNER)
 * - MEMBER -> cannot add anyone
 */
const MAX_ASSIGNABLE: Record<ChannelMemberRole, number> = {
  [ChannelMemberRole.OWNER]: ROLE_WEIGHT[ChannelMemberRole.OWNER],
  [ChannelMemberRole.ADMIN]: ROLE_WEIGHT[ChannelMemberRole.ADMIN],
  [ChannelMemberRole.MEMBER]: -1, // cannot assign
};

@Injectable()
@CommandHandler(AddMemberCommand)
export class AddMemberHandler
  implements ICommandHandler<AddMemberCommand, ChannelMember>
{
  private readonly logger = new Logger(AddMemberHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Add a member to a channel with role hierarchy enforcement.
   *
   * If the target user was previously a member (leftAt is set), the
   * membership is re-activated instead of creating a duplicate row.
   */
  async execute(command: AddMemberCommand): Promise<ChannelMember> {
    const { tenantId, actorUserId, channelId, targetUserId, role } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Load channel
      const channel = await queryRunner.manager.findOne(Channel, {
        where: { id: channelId },
      });

      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found`);
      }

      if (channel.type === ChannelType.DIRECT) {
        throw new BadRequestException('Cannot add members to a DIRECT channel');
      }

      if (channel.isArchived) {
        throw new BadRequestException('Cannot add members to an archived channel');
      }

      // Verify actor is an active member and get their role
      const actorMember = await queryRunner.manager.findOne(ChannelMember, {
        where: { channelId, userId: actorUserId, leftAt: IsNull() },
      });

      if (!actorMember) {
        throw new ForbiddenException('You are not an active member of this channel');
      }

      // Role hierarchy check
      if (ROLE_WEIGHT[actorMember.role] < ROLE_WEIGHT[ChannelMemberRole.ADMIN]) {
        throw new ForbiddenException(
          'Only ADMIN or OWNER can add members to a channel',
        );
      }

      if (ROLE_WEIGHT[role] > MAX_ASSIGNABLE[actorMember.role]) {
        throw new ForbiddenException(
          `${actorMember.role} cannot assign the ${role} role`,
        );
      }

      // Check if target is already a member
      const existingMember = await queryRunner.manager.findOne(ChannelMember, {
        where: { channelId, userId: targetUserId },
      });

      let member: ChannelMember;

      if (existingMember) {
        if (!existingMember.leftAt) {
          throw new BadRequestException(
            `User ${targetUserId} is already an active member of this channel`,
          );
        }

        // Re-activate the membership
        existingMember.leftAt = null;
        existingMember.role = role;
        member = await queryRunner.manager.save(ChannelMember, existingMember);
        this.logger.log(
          `Re-activated member ${targetUserId} in channel ${channelId}`,
        );
      } else {
        const newMember = queryRunner.manager.create(ChannelMember, {
          channelId,
          userId: targetUserId,
          role,
        });
        member = await queryRunner.manager.save(ChannelMember, newMember);
        this.logger.log(
          `Added member ${targetUserId} to channel ${channelId} as ${role}`,
        );
      }

      // Outbox event
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelMemberAdded', tenantId),
        channelId,
        userId: targetUserId,
        role,
        addedBy: actorUserId,
      } as BaseEvent, queryRunner.manager);

      await queryRunner.commitTransaction();
      return member;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
