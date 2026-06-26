import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { GetChannelsQuery } from './get-channels.query';
import { Channel } from '../entities/channel.entity';
import { unreadMessagePredicateSql } from '../../message/unread-message.predicate';

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
    private readonly dataSource: DataSource,
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
    const { tenantId, userId, limit, offset } = query;

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      // Tenant-pinned transaction keeps channel list reads in the same physical
      // schema as channel/member/message writes, preserving read-after-write.
      const qb = queryRunner.manager
        .createQueryBuilder(Channel, 'channel')
        .innerJoin(
          'channel_members',
          'membership',
          'membership."tenantId" = :tenantId AND membership."channelId" = channel.id AND membership."userId" = :userId AND membership."leftAt" IS NULL',
          { tenantId, userId },
        )
        // Subquery: latest message createdAt for ordering
        .addSelect(
          `(SELECT MAX(m."createdAt") FROM messages m WHERE m."tenantId" = :tenantId AND m."channelId" = channel.id AND m."isDeleted" = false)`,
          'channel_lastMessageAt',
        )
        // Subquery: unread count. Built from the canonical unread predicate
        // (ORPHAN-100) so it agrees with the Redis counter + getUnreadCountFromDb
        // — in particular it EXCLUDES the member's own messages.
        .addSelect(
          `(SELECT COUNT(*)::int FROM messages m WHERE m."tenantId" = :tenantId AND m."channelId" = channel.id AND ${unreadMessagePredicateSql(
            { msg: 'm', lastReadAt: 'membership."lastReadAt"', userIdParam: 'userId' },
          )})`,
          'channel_unreadCount',
        )
        // Subquery: active member count
        .addSelect(
          `(SELECT COUNT(*)::int FROM channel_members cm WHERE cm."tenantId" = :tenantId AND cm."channelId" = channel.id AND cm."leftAt" IS NULL)`,
          'channel_memberCount',
        )
        .where('channel."tenantId" = :tenantId', { tenantId })
        .andWhere('channel."isArchived" = false')
        .orderBy('"channel_lastMessageAt"', 'DESC', 'NULLS LAST')
        .offset(offset)
        .limit(limit);

      const [rawAndEntities, total] = await Promise.all([
        qb.getRawAndEntities(),
        qb.clone().getCount(),
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
    });
  }
}
