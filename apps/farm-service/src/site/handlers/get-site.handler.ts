/**
 * Get Site Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Site } from '../entities/site.entity';
import { GetSiteQuery } from '../queries/get-site.query';

@QueryHandler(GetSiteQuery)
export class GetSiteHandler implements IQueryHandler<GetSiteQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly siteAuthorization: SiteAuthorizationService,
  ) {}

  async execute(query: GetSiteQuery): Promise<Site | null> {
    const { siteId, tenantId, caller } = query;

    this.siteAuthorization.assertSiteAssignment({ caller, siteId });

    // Read through the fail-closed tenant boundary. A lost tenant context or a
    // wrong/un-provisioned tenant schema now throws TenantContextError at the
    // boundary instead of silently resolving zero rows, so the `null` below is
    // an honest "no such site" — not a masked connection/search_path failure.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const site = await queryRunner.manager.findOne(Site, {
        where: { id: siteId, tenantId },
      });
      return site ?? null;
    });
  }
}
