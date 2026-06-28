/**
 * List Feeder Calibrations Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

@QueryHandler(ListFeederCalibrationsQuery)
export class ListFeederCalibrationsHandler implements IQueryHandler<ListFeederCalibrationsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListFeederCalibrationsQuery): Promise<FeederCalibration[]> {
    const { equipmentId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.manager.find(FeederCalibration, {
        where: { tenantId, equipmentId },
        order: { feedSizeMm: 'ASC' },
      });
    });
  }
}
