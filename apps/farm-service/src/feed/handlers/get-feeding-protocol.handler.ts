/**
 * Get Feeding Protocol Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GetFeedingProtocolQuery } from '../queries/get-feeding-protocol.query';
import { FeedingProtocol } from '../entities/feeding-protocol.entity';

@QueryHandler(GetFeedingProtocolQuery)
export class GetFeedingProtocolHandler implements IQueryHandler<GetFeedingProtocolQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFeedingProtocolQuery): Promise<FeedingProtocol | null> {
    const { id, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.findOne(FeedingProtocol, {
        where: { id, tenantId },
        relations: ['feed'],
      });
    });
  }
}
