/**
 * Get System Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GetSystemQuery } from '../queries/get-system.query';
import { System } from '../entities/system.entity';

@QueryHandler(GetSystemQuery)
export class GetSystemHandler implements IQueryHandler<GetSystemQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSystemQuery): Promise<System | null> {
    const { systemId, tenantId, includeRelations } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const queryBuilder = queryRunner.manager.createQueryBuilder(System, 'system');
      queryBuilder.where('system.id = :systemId', { systemId });
      queryBuilder.andWhere('system.tenantId = :tenantId', { tenantId });
      queryBuilder.andWhere('system.isDeleted = :isDeleted', { isDeleted: false });

      if (includeRelations) {
        queryBuilder.leftJoinAndSelect('system.site', 'site');
        queryBuilder.leftJoinAndSelect('system.department', 'department');
        queryBuilder.leftJoinAndSelect('system.parentSystem', 'parentSystem');
        queryBuilder.leftJoinAndSelect('system.childSystems', 'childSystems', 'childSystems.isDeleted = :isDeleted', { isDeleted: false });
      }

      return queryBuilder.getOne();
    });
  }
}
