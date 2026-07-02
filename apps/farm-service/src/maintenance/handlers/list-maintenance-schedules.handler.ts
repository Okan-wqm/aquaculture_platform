/**
 * List Maintenance Schedules (filtered, paginated) Query Handler — fail-closed
 * tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
} from '../entities/maintenance-schedule.entity';
import { ListMaintenanceSchedulesQuery } from '../queries/list-maintenance-schedules.query';

@QueryHandler(ListMaintenanceSchedulesQuery)
export class ListMaintenanceSchedulesHandler
  implements IQueryHandler<ListMaintenanceSchedulesQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: ListMaintenanceSchedulesQuery,
  ): Promise<IStandardPaginatedResult<MaintenanceSchedule>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(MaintenanceSchedule, 'ms')
        .where('ms.tenantId = :tenantId', { tenantId });

      if (filter?.status?.length) {
        qb.andWhere('ms.status IN (:...statuses)', { statuses: filter.status });
      }
      if (filter?.category?.length) {
        qb.andWhere('ms.category IN (:...categories)', { categories: filter.category });
      }
      if (filter?.recurrenceType?.length) {
        qb.andWhere("ms.recurrenceRule->>'type' IN (:...types)", { types: filter.recurrenceType });
      }
      if (filter?.assetType) {
        qb.andWhere('ms.assetType = :assetType', { assetType: filter.assetType });
      }
      if (filter?.assetId) {
        qb.andWhere('ms.assetId = :assetId', { assetId: filter.assetId });
      }
      if (filter?.defaultAssigneeId) {
        qb.andWhere('ms.defaultAssigneeId = :assigneeId', { assigneeId: filter.defaultAssigneeId });
      }
      if (filter?.defaultTeamId) {
        qb.andWhere('ms.defaultTeamId = :teamId', { teamId: filter.defaultTeamId });
      }
      if (filter?.nextDueDateFrom) {
        qb.andWhere('ms.nextDueDate >= :dueDateFrom', { dueDateFrom: new Date(filter.nextDueDateFrom) });
      }
      if (filter?.nextDueDateTo) {
        qb.andWhere('ms.nextDueDate <= :dueDateTo', { dueDateTo: new Date(filter.nextDueDateTo) });
      }
      if (filter?.isOverdue) {
        qb.andWhere('ms.nextDueDate < :now', { now: new Date() });
        qb.andWhere('ms.status = :activeStatus', { activeStatus: MaintenanceScheduleStatus.ACTIVE });
      }
      if (filter?.autoGenerateWorkOrder !== undefined) {
        qb.andWhere('ms.autoGenerateWorkOrder = :autoGenerate', {
          autoGenerate: filter.autoGenerateWorkOrder,
        });
      }
      if (filter?.searchTerm) {
        qb.andWhere(
          '(ms.name ILIKE :search OR ms.scheduleCode ILIKE :search OR ms.description ILIKE :search)',
          { search: `%${filter.searchTerm}%` },
        );
      }

      const total = await qb.getCount();

      const validSortFields = ['createdAt', 'nextDueDate', 'name', 'category', 'status', 'scheduleCode'];
      const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'nextDueDate';

      qb.orderBy(`ms.${finalSortBy}`, sortOrder)
        .skip((page - 1) * limit)
        .take(limit);

      const items = await qb.getMany();
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
