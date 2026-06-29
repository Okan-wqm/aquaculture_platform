/**
 * List Auto Rules Query Handler
 *
 * Lists automation rules through the fail-closed tenant boundary (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { AutoRule } from '../entities/auto-rule.entity';
import { ListAutoRulesQuery } from '../queries/list-auto-rules.query';

@QueryHandler(ListAutoRulesQuery)
export class ListAutoRulesHandler implements IQueryHandler<ListAutoRulesQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListAutoRulesQuery): Promise<AutoRule[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(AutoRule, {
        where: { tenantId },
        order: { createdAt: 'DESC' },
      }),
    );
  }
}
