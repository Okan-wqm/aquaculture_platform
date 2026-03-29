import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import { SearchMessagesQuery } from './search-messages.query';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/**
 * Handler for SearchMessagesQuery.
 *
 * Uses PostgreSQL's built-in full-text search (to_tsvector / plainto_tsquery)
 * to search message content. Results are restricted to channels the user is a member of.
 */
@QueryHandler(SearchMessagesQuery)
export class SearchMessagesHandler
  implements IQueryHandler<SearchMessagesQuery, Message[]>
{
  private readonly logger = new Logger(SearchMessagesHandler.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
  ) {}

  async execute(query: SearchMessagesQuery): Promise<Message[]> {
    const { userId, searchQuery, channelId, limit } = query;

    // 1. Get channels the user is a member of
    const memberChannelIds = await this.getUserChannelIds(userId, channelId);
    if (memberChannelIds.length === 0) {
      return [];
    }

    // 2. Full-text search using PostgreSQL to_tsvector
    const qb = this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.attachments', 'att')
      .where('m."channelId" IN (:...channelIds)', { channelIds: memberChannelIds })
      .andWhere('m."isDeleted" = false')
      .andWhere('m."content" IS NOT NULL')
      .andWhere(
        `to_tsvector('english', m."content") @@ plainto_tsquery('english', :searchQuery)`,
        { searchQuery },
      )
      .orderBy(
        `ts_rank(to_tsvector('english', m."content"), plainto_tsquery('english', :searchQuery))`,
        'DESC',
      )
      .addOrderBy('m."createdAt"', 'DESC')
      .take(limit);

    const messages = await qb.getMany();

    this.logger.debug(
      `SearchMessages: query="${searchQuery}", results=${messages.length}`,
    );

    return messages;
  }

  /**
   * Get channel IDs the user is an active member of.
   * If channelId is provided, filters to just that channel (validating membership).
   */
  private async getUserChannelIds(
    userId: string,
    channelId: string | null,
  ): Promise<string[]> {
    const qb = this.channelMemberRepo
      .createQueryBuilder('cm')
      .select('cm."channelId"')
      .where('cm."userId" = :userId', { userId })
      .andWhere('cm."leftAt" IS NULL');

    if (channelId) {
      qb.andWhere('cm."channelId" = :channelId', { channelId });
    }

    const members = await qb.getRawMany<{ channelId: string }>();
    return members.map((m) => m.channelId);
  }
}
