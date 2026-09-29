/**
 * List Feeder Calibrations Query Handler
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

@QueryHandler(ListFeederCalibrationsQuery)
export class ListFeederCalibrationsHandler implements IQueryHandler<ListFeederCalibrationsQuery> {
  async execute(query: ListFeederCalibrationsQuery): Promise<FeederCalibration[]> {
    const { equipmentId, scope } = query;
    const tenantId = scope.tenantId;

    // Read through the fail-closed tenant boundary.
    return scope.manager.find(FeederCalibration, {
      where: { tenantId, equipmentId },
      order: { feedSizeMm: 'ASC' },
    });
  }
}
