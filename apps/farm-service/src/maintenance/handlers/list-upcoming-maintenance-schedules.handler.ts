/**
 * List Upcoming Maintenance Schedules Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, LessThanOrEqual } from 'typeorm';

import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
} from '../entities/maintenance-schedule.entity';
import { ListUpcomingMaintenanceSchedulesQuery } from '../queries/list-upcoming-maintenance-schedules.query';

@QueryHandler(ListUpcomingMaintenanceSchedulesQuery)
export class ListUpcomingMaintenanceSchedulesHandler
  implements IQueryHandler<ListUpcomingMaintenanceSchedulesQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListUpcomingMaintenanceSchedulesQuery): Promise<MaintenanceSchedule[]> {
    const { tenantId, days } = query;
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.find(MaintenanceSchedule, {
        where: {
          tenantId,
          status: MaintenanceScheduleStatus.ACTIVE,
          nextDueDate: LessThanOrEqual(endDate),
        },
        order: { nextDueDate: 'ASC' },
      }),
    );
  }
}
