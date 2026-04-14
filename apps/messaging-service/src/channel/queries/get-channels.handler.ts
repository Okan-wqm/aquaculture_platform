import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';

import { GetChannelsQuery } from './get-channels.query';
import { Channel } from '../entities/channel.entity';
import { ChannelMember } from '../entities/channel-member.entity';

/**
 * Result shape for paginated channel list.
 */
export interface GetChannelsResult {
  items: Channel[];
  total: number;
}

@Injectable()
@QueryHandler(GetChannelsQuery)
export class GetChannelsHandler
  implements IQueryHandler<GetChannelsQuery, GetChannelsResult>
{
  private readonly logger = new Logger(GetChannelsHandler.name);

  constructor(
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    @InjectRepository(ChannelMember)
    private readonly memberRepo: Repository<ChannelMember>,
  ) {}

  /**
   * Return a paginated list of channels where the user is an active member,
   * ordered by the most recent message timestamp descending.
   *
   * Each channel in the result includes:
   * - memberCount: number of active members
   * - unreadCount and lastMessage are computed via subqueries on the messages table.
   *
   * TODO (M-PERF-2): Materialize lastMessageAt as a denormalized column on
   * channels table to eliminate correlated subqueries for large tenant channel lists.
   */
  async execute(query: GetChannelsQuery): Promise<GetChannelsResult> {
    const { userId, limit, offset } = query;

    // Build a query that:
    // 1. Joins channels with channel_members to filter active membership
    // 2. Subqueries for lastMessage timestamp and unreadCount
    // 3. Orders by last message descending (channels with no messages come last)
    const qb = this.channelRepo
      .createQueryBuilder('channel')
      .innerJoin(
        'channel_members',
        'membership',
        'membership."channelId" = channel.id AND membership."userId" = :userId AND membership."leftAt" IS NULL',
        { userId },
      )
      // Subquery: latest message createdAt for ordering
      .addSelect(
        `(SELECT MAX(m."createdAt") FROM messages m WHERE m."channelId" = channel.id AND m."isDeleted" = false)`,
        'channel_lastMessageAt',
      )
      // Subquery: unread count (messages after lastReadAt)
      .addSelect(
        `(SELECT COUNT(*)::int FROM messages m WHERE m."channelId" = channel.id AND m."isDeleted" = false AND m."createdAt" > COALESCE(membership."lastReadAt", '1970-01-01'))`,
        'channel_unreadCount',
      )
      // Subquery: active member count
      .addSelect(
        `(SELECT COUNT(*)::int FROM channel_members cm WHERE cm."channelId" = channel.id AND cm."leftAt" IS NULL)`,
        'channel_memberCount',
      )
      .where('channel."isArchived" = false')
      // SECURITY/CORRECTNESS: alias must be quoted — PostgreSQL folds
      // unquoted identifiers to lowercase, so `channel_lastMessageAt`
      // becomes `channel_lastmessageat` at parse time and the ORDER BY
      // cannot resolve the addSelect alias. Quoting preserves the
      // exact alias emitted at line 61.
      .orderBy('"channel_lastMessageAt"', 'DESC', 'NULLS LAST')
      .offset(offset)
      .limit(limit);

    const [rawAndEntities, total] = await Promise.all([
      qb.getRawAndEntities(),
      qb.getCount(),
    ]);

    // Merge computed fields into entity objects
    const items = rawAndEntities.entities.map((entity, idx) => {
      const raw = rawAndEntities.raw[idx];
      // Attach computed values as non-column properties (GraphQL @ResolveField will use them)
      (entity as Channel & { unreadCount: number }).unreadCount =
        parseInt(raw['channel_unreadCount'] ?? '0', 10);
      (entity as Channel & { memberCount: number }).memberCount =
        parseInt(raw['channel_memberCount'] ?? '0', 10);
      (entity as Channel & { lastMessageAt: Date | null }).lastMessageAt =
        raw['channel_lastMessageAt'] ? new Date(raw['channel_lastMessageAt']) : null;
      return entity;
    });

    this.logger.debug(
      `Fetched ${items.length}/${total} channels for user ${userId}`,
    );

    return { items, total };
  }
}
