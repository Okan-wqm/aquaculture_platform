/**
 * List Recurring Templates Query Handler
 *
 * Lists recurring task templates through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { RecurringTemplate } from '../entities/recurring-template.entity';
import { ListRecurringTemplatesQuery } from '../queries/list-recurring-templates.query';

@QueryHandler(ListRecurringTemplatesQuery)
export class ListRecurringTemplatesHandler
  implements IQueryHandler<ListRecurringTemplatesQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListRecurringTemplatesQuery): Promise<RecurringTemplate[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(RecurringTemplate, {
        where: { tenantId },
        order: { createdAt: 'DESC' },
      }),
    );
  }
}
