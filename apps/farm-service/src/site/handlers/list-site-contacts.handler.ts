import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListSiteContactsQuery } from '../queries/list-site-contacts.query';
import { SiteContact } from '../entities/site-contact.entity';

@QueryHandler(ListSiteContactsQuery)
export class ListSiteContactsHandler
  implements IQueryHandler<ListSiteContactsQuery, SiteContact[]>
{
  constructor(
    @InjectRepository(SiteContact)
    private readonly siteContactRepository: Repository<SiteContact>,
  ) {}

  async execute(query: ListSiteContactsQuery): Promise<SiteContact[]> {
    const { siteId, tenantId } = query;
    return this.siteContactRepository.find({
      where: { tenantId, siteId },
      order: {
        isPrimary: 'DESC',
        createdAt: 'ASC',
      },
    });
  }
}
