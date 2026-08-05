import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SiteAccessCatalogItemResponse } from '../dto/site-access-catalog.response';
import { Site } from '../entities/site.entity';
import { GetActiveSiteAccessCatalogQuery } from '../queries/get-active-site-access-catalog.query';

/**
 * A tenant's assignable Site catalog is intentionally bounded. The handler
 * fetches one extra row so overflow fails closed instead of returning a
 * silently incomplete authority-management list.
 */
export const ACTIVE_SITE_COLLECTION_HARD_CAP = 5_000;

export class ActiveSiteCollectionLimitExceededError extends Error {
  constructor() {
    super('Active site collection exceeds the supported limit');
    this.name = 'ActiveSiteCollectionLimitExceededError';
  }
}

@QueryHandler(GetActiveSiteAccessCatalogQuery)
export class GetActiveSiteAccessCatalogHandler
  implements IQueryHandler<GetActiveSiteAccessCatalogQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetActiveSiteAccessCatalogQuery): Promise<SiteAccessCatalogItemResponse[]> {
    return runInTenantRead(this.dataSource, 'farm', query.tenantId, async (queryRunner) => {
      const sites = await queryRunner.manager
        .createQueryBuilder(Site, 'site')
        .select(['site.id', 'site.name', 'site.code'])
        .where('site.tenantId = :tenantId', { tenantId: query.tenantId })
        .andWhere('site.isActive = :isActive', { isActive: true })
        .andWhere('site.isDeleted = :isDeleted', { isDeleted: false })
        .orderBy('site.id', 'ASC')
        .take(ACTIVE_SITE_COLLECTION_HARD_CAP + 1)
        .getMany();

      if (sites.length > ACTIVE_SITE_COLLECTION_HARD_CAP) {
        throw new ActiveSiteCollectionLimitExceededError();
      }

      return sites.map(({ id, name, code }) => ({ id, name, code }));
    });
  }
}
