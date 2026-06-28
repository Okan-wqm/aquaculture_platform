import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListSiteContactsQuery } from '../queries/list-site-contacts.query';
import { SiteContact } from '../entities/site-contact.entity';

@QueryHandler(ListSiteContactsQuery)
export class ListSiteContactsHandler
  implements IQueryHandler<ListSiteContactsQuery, SiteContact[]>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSiteContactsQuery): Promise<SiteContact[]> {
    const { siteId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.find(SiteContact, {
        where: { tenantId, siteId },
        order: {
          isPrimary: 'DESC',
          createdAt: 'ASC',
        },
      });
    });
  }
}
