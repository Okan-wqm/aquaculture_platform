/**
 * List Overdue Work Orders Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In, LessThan } from 'typeorm';

import { WorkOrder, WorkOrderStatus } from '../entities/work-order.entity';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';

@QueryHandler(ListOverdueWorkOrdersQuery)
export class ListOverdueWorkOrdersHandler implements IQueryHandler<ListOverdueWorkOrdersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListOverdueWorkOrdersQuery): Promise<WorkOrder[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(WorkOrder, {
        where: {
          tenantId,
          dueDate: LessThan(new Date()),
          status: In([
            WorkOrderStatus.DRAFT,
            WorkOrderStatus.PENDING_APPROVAL,
            WorkOrderStatus.APPROVED,
            WorkOrderStatus.SCHEDULED,
            WorkOrderStatus.IN_PROGRESS,
            WorkOrderStatus.ON_HOLD,
          ]),
        },
        order: { dueDate: 'ASC' },
      }),
    );
  }
}
