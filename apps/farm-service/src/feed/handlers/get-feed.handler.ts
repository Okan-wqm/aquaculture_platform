/**
 * Get Feed Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetFeedQuery } from '../queries/get-feed.query';
import { Feed } from '../entities/feed.entity';

@QueryHandler(GetFeedQuery)
export class GetFeedHandler implements IQueryHandler<GetFeedQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFeedQuery): Promise<Feed> {
    const { feedId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const feed = await queryRunner.manager.findOne(Feed, {
        where: { id: feedId, tenantId },
      });

      if (!feed) {
        throw new NotFoundException(`Feed with ID "${feedId}" not found`);
      }

      return feed;
    });
  }
}
