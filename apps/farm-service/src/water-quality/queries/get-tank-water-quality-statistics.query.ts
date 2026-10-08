/**
 * Get Water Quality Statistics Query for one unit (a tank or water equipment)
 */
import { IQuery } from '@platform/cqrs';

export class GetTankWaterQualityStatisticsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly unitId: string,
    public readonly days: number = 7,
  ) {}
}
