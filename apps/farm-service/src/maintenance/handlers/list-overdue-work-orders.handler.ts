/**
 * List Overdue Work Orders Query Handler — fail-closed tenant boundary.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { In, LessThan } from 'typeorm';

import { WorkOrder, WorkOrderStatus } from '../entities/work-order.entity';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';

// Statuses that count as "open" for overdue detection (not completed/verified/cancelled).
const OPEN_WORK_ORDER_STATUSES = [
  WorkOrderStatus.DRAFT,
  WorkOrderStatus.PENDING_APPROVAL,
  WorkOrderStatus.APPROVED,
  WorkOrderStatus.SCHEDULED,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.ON_HOLD,
];

@QueryHandler(ListOverdueWorkOrdersQuery)
export class ListOverdueWorkOrdersHandler implements IQueryHandler<ListOverdueWorkOrdersQuery> {
  async execute(query: ListOverdueWorkOrdersQuery): Promise<WorkOrder[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    return scope.manager.find(WorkOrder, {
      where: { tenantId, dueDate: LessThan(new Date()), status: In(OPEN_WORK_ORDER_STATUSES) },
      order: { dueDate: 'ASC' },
    });
  }
}
