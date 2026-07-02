/**
 * List Work Orders (filtered, paginated) Query Handler — fail-closed tenant
 * boundary (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { WorkOrder, WorkOrderStatus } from '../entities/work-order.entity';
import { ListWorkOrdersQuery } from '../queries/list-work-orders.query';

@QueryHandler(ListWorkOrdersQuery)
export class ListWorkOrdersHandler implements IQueryHandler<ListWorkOrdersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListWorkOrdersQuery): Promise<IStandardPaginatedResult<WorkOrder>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(WorkOrder, 'wo')
        .where('wo.tenantId = :tenantId', { tenantId });

      if (filter?.status?.length) {
        qb.andWhere('wo.status IN (:...statuses)', { statuses: filter.status });
      }
      if (filter?.type?.length) {
        qb.andWhere('wo.type IN (:...types)', { types: filter.type });
      }
      if (filter?.priority?.length) {
        qb.andWhere('wo.priority IN (:...priorities)', { priorities: filter.priority });
      }
      if (filter?.assetType) {
        qb.andWhere('wo.assetType = :assetType', { assetType: filter.assetType });
      }
      if (filter?.assetId) {
        qb.andWhere('wo.assetId = :assetId', { assetId: filter.assetId });
      }
      if (filter?.assignedTo) {
        qb.andWhere('wo.assignedTo = :assignedTo', { assignedTo: filter.assignedTo });
      }
      if (filter?.assignedTeamId) {
        qb.andWhere('wo.assignedTeamId = :assignedTeamId', { assignedTeamId: filter.assignedTeamId });
      }
      if (filter?.maintenanceScheduleId) {
        qb.andWhere('wo.maintenanceScheduleId = :scheduleId', {
          scheduleId: filter.maintenanceScheduleId,
        });
      }
      if (filter?.dueDateFrom) {
        qb.andWhere('wo.dueDate >= :dueDateFrom', { dueDateFrom: new Date(filter.dueDateFrom) });
      }
      if (filter?.dueDateTo) {
        qb.andWhere('wo.dueDate <= :dueDateTo', { dueDateTo: new Date(filter.dueDateTo) });
      }
      if (filter?.createdFrom) {
        qb.andWhere('wo.createdAt >= :createdFrom', { createdFrom: new Date(filter.createdFrom) });
      }
      if (filter?.createdTo) {
        qb.andWhere('wo.createdAt <= :createdTo', { createdTo: new Date(filter.createdTo) });
      }
      if (filter?.isOverdue) {
        qb.andWhere('wo.dueDate < :now', { now: new Date() });
        qb.andWhere('wo.status NOT IN (:...completedStatuses)', {
          completedStatuses: [
            WorkOrderStatus.COMPLETED,
            WorkOrderStatus.VERIFIED,
            WorkOrderStatus.CANCELLED,
          ],
        });
      }
      if (filter?.isRecurring !== undefined) {
        qb.andWhere('wo.isRecurring = :isRecurring', { isRecurring: filter.isRecurring });
      }
      if (filter?.searchTerm) {
        qb.andWhere(
          '(wo.title ILIKE :search OR wo.workOrderCode ILIKE :search OR wo.description ILIKE :search)',
          { search: `%${filter.searchTerm}%` },
        );
      }

      const total = await qb.getCount();

      const validSortFields = ['createdAt', 'dueDate', 'priority', 'status', 'title', 'workOrderCode'];
      const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      qb.orderBy(`wo.${finalSortBy}`, sortOrder)
        .skip((page - 1) * limit)
        .take(limit);

      const items = await qb.getMany();
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
