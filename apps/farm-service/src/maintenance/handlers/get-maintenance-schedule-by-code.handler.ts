/**
 * Get Maintenance Schedule (by code) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { MaintenanceSchedule } from '../entities/maintenance-schedule.entity';
import { GetMaintenanceScheduleByCodeQuery } from '../queries/get-maintenance-schedule-by-code.query';

@QueryHandler(GetMaintenanceScheduleByCodeQuery)
export class GetMaintenanceScheduleByCodeHandler
  implements IQueryHandler<GetMaintenanceScheduleByCodeQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMaintenanceScheduleByCodeQuery): Promise<MaintenanceSchedule> {
    const { tenantId, code } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const schedule = await queryRunner.manager.findOne(MaintenanceSchedule, {
        where: { scheduleCode: code, tenantId },
      });
      if (!schedule) {
        throw new NotFoundException(`Bakım planı bulunamadı: ${code}`);
      }
      return schedule;
    });
  }
}
