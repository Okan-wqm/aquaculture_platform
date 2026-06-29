/**
 * Get Tank Water Quality Statistics Query
 */
import { IQuery } from '@platform/cqrs';

export class GetTankWaterQualityStatisticsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
    public readonly days: number = 7,
  ) {}
}
