import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    @InjectRepository(SupplierSite)
    private readonly supplierSiteRepository: Repository<SupplierSite>,
  ) {}

  async execute(query: ListSupplierSitesQuery): Promise<SupplierSite[]> {
    const { supplierId, tenantId } = query;
    return this.supplierSiteRepository.find({
      where: { tenantId, supplierId },
      order: {
        isPreferred: 'DESC',
        createdAt: 'ASC',
      },
    });
  }
}
