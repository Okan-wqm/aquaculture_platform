import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { RemoveMemberCommand } from './remove-member.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';

@Injectable()
@CommandHandler(RemoveMemberCommand)
export class RemoveMemberHandler
  implements ICommandHandler<RemoveMemberCommand, boolean>
{
  private readonly logger = new Logger(RemoveMemberHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Remove a member from a channel or allow self-leave.
   *
   * Rules:
   * - Self-leave: any member can leave (sets leftAt = NOW)
   * - Remove other: requires ADMIN+ channel role
   * - OWNER cannot be removed (must transfer ownership first)
   */
  async execute(command: RemoveMemberCommand): Promise<boolean> {
    const { tenantId, actorUserId, channelId, targetUserId } = command;
    const isSelfLeave = actorUserId === targetUserId;

    await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const channel = await queryRunner.manager.findOne(Channel, {
        where: { tenantId, id: channelId },
      });

      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found`);
      }

      if (channel.type === ChannelType.DIRECT) {
        throw new BadRequestException(
          'Cannot remove members from a DIRECT channel. Delete the channel instead.',
        );
      }

      // Load target member
      const targetMember = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId: targetUserId, leftAt: IsNull() },
      });

      if (!targetMember) {
        throw new NotFoundException(
          `User ${targetUserId} is not an active member of channel ${channelId}`,
        );
      }

      // OWNER cannot be removed
      if (targetMember.role === ChannelMemberRole.OWNER) {
        throw new ForbiddenException(
          'Cannot remove the channel OWNER. Transfer ownership first.',
        );
      }

      if (!isSelfLeave) {
        // Actor must be ADMIN or OWNER
        const actorMember = await queryRunner.manager.findOne(ChannelMember, {
          where: { tenantId, channelId, userId: actorUserId, leftAt: IsNull() },
        });

        if (!actorMember) {
          throw new ForbiddenException('You are not an active member of this channel');
        }

        const actorIsPrivileged =
          actorMember.role === ChannelMemberRole.ADMIN ||
          actorMember.role === ChannelMemberRole.OWNER;

        if (!actorIsPrivileged) {
          throw new ForbiddenException(
            'Only ADMIN or OWNER can remove other members from the channel',
          );
        }
      }

      // Soft-remove: set leftAt
      targetMember.leftAt = new Date();
      await queryRunner.manager.save(ChannelMember, targetMember);

      // Outbox event
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelMemberRemoved', tenantId),
        channelId,
        userId: targetUserId,
        removedBy: actorUserId,
        selfLeave: isSelfLeave,
      },  queryRunner.manager);

      this.logger.log(
        isSelfLeave
          ? `User ${targetUserId} left channel ${channelId}`
          : `User ${targetUserId} removed from channel ${channelId} by ${actorUserId}`,
      );
    });

    return true;
  }
}
