import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListSupplierSitesQuery } from '../queries/list-supplier-sites.query';
import { SupplierSite } from '../entities/supplier-site.entity';

/**
 * Reads `SupplierSite` rows for `(tenantId, supplierId)` ordered with
 * the preferred row first, then by createdAt. The single ORDER BY
 * trick (DESC on isPreferred boolean = preferred-first) keeps the
 * SQL plan a single index scan instead of two queries.
 */
@QueryHandler(ListSupplierSitesQuery)
export class ListSupplierSitesHandler
  implements IQueryHandler<ListSupplierSitesQuery, SupplierSite[]>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSupplierSitesQuery): Promise<SupplierSite[]> {
    const { supplierId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.find(SupplierSite, {
        where: { tenantId, supplierId },
        order: {
          isPreferred: 'DESC',
          createdAt: 'ASC',
        },
      });
    });
  }
}
