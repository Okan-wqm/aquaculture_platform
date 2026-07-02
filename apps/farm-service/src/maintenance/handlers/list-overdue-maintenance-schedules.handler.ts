/**
 * List Overdue Maintenance Schedules Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, LessThanOrEqual } from 'typeorm';

import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
} from '../entities/maintenance-schedule.entity';
import { ListOverdueMaintenanceSchedulesQuery } from '../queries/list-overdue-maintenance-schedules.query';

@QueryHandler(ListOverdueMaintenanceSchedulesQuery)
export class ListOverdueMaintenanceSchedulesHandler
  implements IQueryHandler<ListOverdueMaintenanceSchedulesQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListOverdueMaintenanceSchedulesQuery): Promise<MaintenanceSchedule[]> {
    const { tenantId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(MaintenanceSchedule, {
        where: {
          tenantId,
          status: MaintenanceScheduleStatus.ACTIVE,
          nextDueDate: LessThanOrEqual(new Date()),
        },
        order: { nextDueDate: 'ASC' },
      }),
    );
  }
}
