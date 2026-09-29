/**
 * ListStorageItemSitePoliciesHandler — per-site stock policies visible to the
 * caller (plan K8 tier 1).
 *
 * WHY site-scoped: a site policy reveals which stock a site holds; a
 * MODULE_USER sees only their assigned sites (SEC-HIGH-051 vocabulary),
 * managers see every site.
 */
import { InjectDataSource } from '@nestjs/typeorm';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { DataSource, FindOptionsWhere, In } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { ListStorageItemSitePoliciesQuery } from '../queries/list-storage-item-site-policies.query';
import { StorageItemSitePolicy } from '../entities/storage-item-site-policy.entity';

@QueryHandler(ListStorageItemSitePoliciesQuery)
export class ListStorageItemSitePoliciesHandler
  implements IQueryHandler<ListStorageItemSitePoliciesQuery, StorageItemSitePolicy[]>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly siteAuth: SiteAuthorizationService,
  ) {}

  async execute(query: ListStorageItemSitePoliciesQuery): Promise<StorageItemSitePolicy[]> {
    const { tenantId, caller, filter } = query;
    const scope = this.siteAuth.resolveSiteScope(caller);
    if (scope.kind === 'ASSIGNED' && scope.siteIds.length === 0) return [];

    const where: FindOptionsWhere<StorageItemSitePolicy> = { tenantId };
    if (filter.itemType) where.itemType = filter.itemType;
    if (filter.itemId) where.itemId = filter.itemId;
    if (scope.kind === 'ASSIGNED') {
      // Fail-closed: a requested site outside the assignment yields nothing.
      const visible = filter.siteId
        ? scope.siteIds.filter((siteId) => siteId === filter.siteId)
        : [...scope.siteIds];
      if (visible.length === 0) return [];
      where.siteId = In(visible);
    } else if (filter.siteId) {
      where.siteId = filter.siteId;
    }

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      tenantManagerRepo(queryRunner.manager, StorageItemSitePolicy, tenantId).find({
        where,
        order: { siteId: 'ASC', itemType: 'ASC', itemId: 'ASC' },
      }),
    );
  }
}
