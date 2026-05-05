import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { SearchMessagesQuery } from './search-messages.query';
import { Message } from '../entities/message.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';

/**
 * Handler for SearchMessagesQuery.
 *
 * Uses PostgreSQL's built-in full-text search (to_tsvector / plainto_tsquery)
 * to search message content. Results are restricted to channels the user is a member of.
 *
 * SECURITY (C-06): Tenant isolation is enforced at two levels:
 *   1. PostgreSQL search_path — set by TenantSchemaMiddleware per-request to
 *      the tenant-specific schema (tenant_<uuid>), so all TypeORM queries
 *      automatically target the correct tenant's tables.
 *   2. Defense-in-depth — this handler validates that tenantId is present in
 *      the query object. The tenantId comes from the controller which extracts
 *      it from the verified JWT, not from any user-controlled input.
 */
@QueryHandler(SearchMessagesQuery)
export class SearchMessagesHandler
  implements IQueryHandler<SearchMessagesQuery, Message[]>
{
  private readonly logger = new Logger(SearchMessagesHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Statement timeout for search queries (ms). */
  private static readonly SEARCH_TIMEOUT_MS = 5000;

  async execute(query: SearchMessagesQuery): Promise<Message[]> {
    const { tenantId, userId, searchQuery, channelId, limit } = query;

    // SECURITY (C-06): Require tenantId as defense-in-depth. The primary tenant
    // isolation is the PostgreSQL search_path (set by TenantSchemaMiddleware),
    // but we assert tenantId presence to catch programming errors where a query
    // is dispatched without proper tenant context.
    if (!tenantId) {
      throw new BadRequestException(
        'Tenant context is required for message search.',
      );
    }

    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      // 1. Get channels the user is a member of inside the tenant schema.
      const memberChannelIds = await this.getUserChannelIds(
        queryRunner.manager,
        tenantId,
        userId,
        channelId,
      );
      if (memberChannelIds.length === 0) {
        return [];
      }

      // 2. Full-text search with 90-day partition pruning + transaction-local timeout.
      const defaultSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      await queryRunner.query(
        `SET LOCAL statement_timeout = '${SearchMessagesHandler.SEARCH_TIMEOUT_MS}'`,
      );
      const messages = await queryRunner.manager
        .createQueryBuilder(Message, 'm')
        .leftJoinAndSelect('m.attachments', 'att')
        .where('m."tenantId" = :tenantId', { tenantId })
        .andWhere('m."channelId" IN (:...channelIds)', { channelIds: memberChannelIds })
        .andWhere('m."isDeleted" = false')
        .andWhere('m."content" IS NOT NULL')
        .andWhere('m."createdAt" > :since', { since: defaultSince })
        .andWhere(
          `to_tsvector('english', m."content") @@ plainto_tsquery('english', :searchQuery)`,
          { searchQuery },
        )
        .orderBy(
          `ts_rank(to_tsvector('english', m."content"), plainto_tsquery('english', :searchQuery))`,
          'DESC',
        )
        .addOrderBy('m.createdAt', 'DESC')
        .take(limit)
        .getMany();

      this.logger.debug(
        `SearchMessages: tenant=${tenantId}, query="${searchQuery}", results=${messages.length}`,
      );
      return messages;
    });
  }

  /**
   * Get channel IDs the user is an active member of.
   * If channelId is provided, filters to just that channel (validating membership).
   *
   * SECURITY (C-06): This query runs within the tenant-scoped search_path,
   * so it only returns channel memberships from the current tenant's schema.
   */
  private async getUserChannelIds(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    channelId: string | null,
  ): Promise<string[]> {
    const qb = manager
      .createQueryBuilder(ChannelMember, 'cm')
      .select('cm."channelId"')
      .where('cm."tenantId" = :tenantId', { tenantId })
      .andWhere('cm."userId" = :userId', { userId })
      .andWhere('cm."leftAt" IS NULL');

    if (channelId) {
      qb.andWhere('cm."channelId" = :channelId', { channelId });
    }

    const members = await qb.getRawMany<{ channelId: string }>();
    return members.map((m) => m.channelId);
  }
}
