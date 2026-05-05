import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { GetChannelQuery } from './get-channel.query';
import { Channel } from '../entities/channel.entity';
import { ChannelMember } from '../entities/channel-member.entity';

@Injectable()
@QueryHandler(GetChannelQuery)
export class GetChannelHandler
  implements IQueryHandler<GetChannelQuery, Channel>
{
  private readonly logger = new Logger(GetChannelHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Return a single channel by ID, including its active members list.
   * The requesting user must be an active member of the channel.
   */
  async execute(query: GetChannelQuery): Promise<Channel> {
    const { tenantId, userId, channelId } = query;

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const channel = await queryRunner.manager.findOne(Channel, {
        where: { tenantId, id: channelId },
      });

      if (!channel) {
        throw new NotFoundException(`Channel ${channelId} not found`);
      }

      // Verify user is an active member
      const membership = await queryRunner.manager.findOne(ChannelMember, {
        where: { tenantId, channelId, userId, leftAt: IsNull() },
      });

      if (!membership) {
        throw new ForbiddenException(
          'You are not an active member of this channel',
        );
      }

      // Load all active members
      const activeMembers = await queryRunner.manager.find(ChannelMember, {
        where: { tenantId, channelId, leftAt: IsNull() },
        order: { joinedAt: 'ASC' },
      });

      channel.members = activeMembers;

      this.logger.debug(
        `Fetched channel ${channelId} with ${activeMembers.length} active members`,
      );

      return channel;
    });
  }
}
