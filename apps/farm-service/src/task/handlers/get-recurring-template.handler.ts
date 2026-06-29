/**
 * Get Recurring Template Query Handler
 *
 * Reads a single recurring task template through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { RecurringTemplate } from '../entities/recurring-template.entity';
import { GetRecurringTemplateQuery } from '../queries/get-recurring-template.query';

@QueryHandler(GetRecurringTemplateQuery)
export class GetRecurringTemplateHandler
  implements IQueryHandler<GetRecurringTemplateQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetRecurringTemplateQuery): Promise<RecurringTemplate> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const template = await queryRunner.manager.findOne(RecurringTemplate, {
        where: { id, tenantId },
      });
      if (!template) {
        throw new NotFoundException(`Tekrarlayan şablon bulunamadı: ${id}`);
      }
      return template;
    });
  }
}
