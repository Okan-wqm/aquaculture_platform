/**
 * List Feeder Calibrations Query Handler
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { FeederCalibration } from '../entities/feeder-calibration.entity';

@QueryHandler(ListFeederCalibrationsQuery)
export class ListFeederCalibrationsHandler implements IQueryHandler<ListFeederCalibrationsQuery> {
  constructor(
    @InjectRepository(FeederCalibration)
    private readonly calibrationRepository: Repository<FeederCalibration>,
  ) {}

  async execute(query: ListFeederCalibrationsQuery): Promise<FeederCalibration[]> {
    const { equipmentId, tenantId } = query;

    return this.calibrationRepository.find({
      where: { tenantId, equipmentId },
      order: { feedSizeMm: 'ASC' },
    });
  }
}
