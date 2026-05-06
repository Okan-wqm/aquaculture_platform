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
import { UpdateChannelCommand } from './update-channel.command';
import { Channel, ChannelType } from '../entities/channel.entity';
import { ChannelMember, ChannelMemberRole } from '../entities/channel-member.entity';
import { sanitizeContent } from '../../shared/sanitize';

@Injectable()
@CommandHandler(UpdateChannelCommand)
export class UpdateChannelHandler
  implements ICommandHandler<UpdateChannelCommand, Channel>
{
  private readonly logger = new Logger(UpdateChannelHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Update channel metadata (name, description, avatarUrl).
   * Requires ADMIN+ channel role. DIRECT channels cannot be updated.
   */
  async execute(command: UpdateChannelCommand): Promise<Channel> {
    const { tenantId, userId, channelId, input } = command;

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const channel = await queryRunner.manager.findOne(Channel, {
        where: { tenantId, id: channelId },
      });

      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found`);
      }

      if (channel.type === ChannelType.DIRECT) {
        throw new BadRequestException('DIRECT channels cannot be renamed or updated');
      }

      if (channel.isArchived) {
        throw new BadRequestException('Cannot update an archived channel');
      }

      // Verify actor has ADMIN+ role
      const actorMember = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId, leftAt: IsNull() },
      });

      if (!actorMember) {
        throw new ForbiddenException('You are not an active member of this channel');
      }

      const isPrivileged =
        actorMember.role === ChannelMemberRole.ADMIN ||
        actorMember.role === ChannelMemberRole.OWNER;

      if (!isPrivileged) {
        throw new ForbiddenException(
          'Only ADMIN or OWNER can update channel settings',
        );
      }

      // Apply partial updates with sanitization
      const changes: Record<string, unknown> = {};

      if (input.name !== undefined) {
        channel.name = sanitizeContent(input.name);
        changes['name'] = channel.name;
      }

      if (input.description !== undefined) {
        channel.description = sanitizeContent(input.description);
        changes['description'] = channel.description;
      }

      if (input.avatarUrl !== undefined) {
        try {
          const url = new URL(input.avatarUrl);
          if (!['http:', 'https:'].includes(url.protocol)) {
            throw new BadRequestException('Only http/https URLs allowed for avatar');
          }
        } catch (err) {
          if (err instanceof BadRequestException) throw err;
          throw new BadRequestException('Invalid avatar URL');
        }
        channel.avatarUrl = input.avatarUrl;
        changes['avatarUrl'] = channel.avatarUrl;
      }

      const updatedChannel = await queryRunner.manager.save(Channel, channel);

      // Write outbox event for ChannelUpdated
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('ChannelUpdated', tenantId),
        channelId: channel.id,
        ...changes,
      },  queryRunner.manager);

      this.logger.log(`Channel ${channelId} updated by user ${userId}`);
      return updatedChannel;
    });
  }
}
