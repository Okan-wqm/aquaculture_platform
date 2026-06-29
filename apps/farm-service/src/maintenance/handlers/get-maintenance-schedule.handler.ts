/**
 * Get Maintenance Schedule (by id) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { MaintenanceSchedule } from '../entities/maintenance-schedule.entity';
import { GetMaintenanceScheduleQuery } from '../queries/get-maintenance-schedule.query';

@QueryHandler(GetMaintenanceScheduleQuery)
export class GetMaintenanceScheduleHandler implements IQueryHandler<GetMaintenanceScheduleQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMaintenanceScheduleQuery): Promise<MaintenanceSchedule> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const schedule = await queryRunner.manager.findOne(MaintenanceSchedule, {
        where: { id, tenantId },
      });
      if (!schedule) {
        throw new NotFoundException(`Bakım planı bulunamadı: ${id}`);
      }
      return schedule;
    });
  }
}
