import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, ForbiddenException } from '@nestjs/common';
import { Repository, IsNull } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { GetMessagesSinceQuery } from './get-messages-since.query';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/** Hard limit for offline sync to prevent unbounded queries */
const SYNC_LIMIT = 500;

/**
 * Handler for GetMessagesSinceQuery.
 *
 * Returns messages created after a given timestamp in a specific channel.
 * Used for offline sync scenarios (mobile reconnection, etc.).
 */
@QueryHandler(GetMessagesSinceQuery)
export class GetMessagesSinceHandler
  implements IQueryHandler<GetMessagesSinceQuery, Message[]>
{
  private readonly logger = new Logger(GetMessagesSinceHandler.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
  ) {}

  async execute(query: GetMessagesSinceQuery): Promise<Message[]> {
    const { userId, channelId, since } = query;

    // 1. Validate channel membership
    const membership = await this.channelMemberRepo.findOne({
      where: { channelId, userId, leftAt: IsNull() },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this channel.');
    }

    // 2. Fetch messages since timestamp
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.attachments', 'att')
      .where('m."channelId" = :channelId', { channelId })
      .andWhere('m."createdAt" > :since', { since })
      .andWhere('m."isDeleted" = false')
      .orderBy('m."createdAt"', 'ASC')
      .addOrderBy('m."id"', 'ASC')
      .take(SYNC_LIMIT)
      .getMany();

    this.logger.debug(
      `GetMessagesSince: channel=${channelId}, since=${since.toISOString()}, returned=${messages.length}`,
    );

    return messages;
  }
}
