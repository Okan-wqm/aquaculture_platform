/**
 * Get System Water Quality Statistics Query (aggregate over all tanks in a system)
 */
import { IQuery } from '@platform/cqrs';

export class GetSystemWaterQualityStatisticsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly systemId: string,
    public readonly days: number = 7,
  ) {}
}
