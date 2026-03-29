import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

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
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>,
  ) {}

  /**
   * Return a single channel by ID, including its active members list.
   * The requesting user must be an active member of the channel.
   */
  async execute(query: GetChannelQuery): Promise<Channel> {
    const { userId, channelId } = query;

    const channel = await this.channelRepo.findOne({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundException(`Channel ${channelId} not found`);
    }

    // Verify user is an active member
    const membership = await this.memberRepo.findOne({
      where: { channelId, userId, leftAt: IsNull() },
    });

    if (!membership) {
      throw new ForbiddenException(
        'You are not an active member of this channel',
      );
    }

    // Load all active members
    const activeMembers = await this.memberRepo.find({
      where: { channelId, leftAt: IsNull() },
      order: { joinedAt: 'ASC' },
    });

    channel.members = activeMembers;

    this.logger.debug(
      `Fetched channel ${channelId} with ${activeMembers.length} active members`,
    );

    return channel;
  }
}
