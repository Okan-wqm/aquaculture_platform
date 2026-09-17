/**
 * Feeder Setup Query Handler
 *
 * Returns the feeder's capability AND its per-feed calibrations together. They
 * are read as one because neither is interpretable alone: a grams-per-minute
 * figure is meaningless without the speed band it holds on, and a capability
 * row is meaningless without knowing which feeds it can dose.
 *
 * A `capability` of null means the equipment was never commissioned as a feeder
 * — a distinct state from "commissioned but not yet calibrated", and the reason
 * a dose plan would be refused.
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { FeederCalibration } from '../entities/feeder-calibration.entity';
import { FeederCapability } from '../entities/feeder-capability.entity';

export interface FeederSetup {
  capability: FeederCapability | null;
  calibrations: FeederCalibration[];
}

@QueryHandler(ListFeederCalibrationsQuery)
export class ListFeederCalibrationsHandler
  implements IQueryHandler<ListFeederCalibrationsQuery, FeederSetup>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListFeederCalibrationsQuery): Promise<FeederSetup> {
    const { equipmentId, tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const capability = await tenantManagerRepo(
        queryRunner.manager,
        FeederCapability,
        tenantId,
      ).findOne({ where: { tenantId, equipmentId } });

      const calibrations = await queryRunner.manager.find(FeederCalibration, {
        where: { tenantId, equipmentId },
        order: { feedId: 'ASC' },
      });

      return { capability: capability ?? null, calibrations };
    });
  }
}
