/**
 * Get Health Event (by id) Query Handler — fail-closed tenant boundary.
 * Returns null when absent (the GraphQL field is nullable).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HealthEvent } from '../entities/health-event.entity';
import { GetHealthEventQuery } from '../queries/get-health-event.query';

@QueryHandler(GetHealthEventQuery)
export class GetHealthEventHandler implements IQueryHandler<GetHealthEventQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHealthEventQuery): Promise<HealthEvent | null> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(HealthEvent, { where: { id, tenantId } }),
    );
  }
}
