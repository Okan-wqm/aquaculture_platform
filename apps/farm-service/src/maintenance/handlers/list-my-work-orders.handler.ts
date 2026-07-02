/**
 * List My Work Orders (assigned to a user) Query Handler — fail-closed tenant
 * boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';

import { WorkOrder, WorkOrderStatus } from '../entities/work-order.entity';
import { ListMyWorkOrdersQuery } from '../queries/list-my-work-orders.query';

@QueryHandler(ListMyWorkOrdersQuery)
export class ListMyWorkOrdersHandler implements IQueryHandler<ListMyWorkOrdersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListMyWorkOrdersQuery): Promise<WorkOrder[]> {
    const { tenantId, userId, activeOnly } = query;
    const whereClause: Record<string, unknown> = {
      tenantId,
      assignedTo: userId,
    };
    if (activeOnly) {
      whereClause.status = In([
        WorkOrderStatus.APPROVED,
        WorkOrderStatus.SCHEDULED,
        WorkOrderStatus.IN_PROGRESS,
      ]);
    }

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WorkOrder, {
        where: whereClause,
        order: { priority: 'DESC', dueDate: 'ASC' },
      }),
    );
  }
}
