/**
 * Get System Water Quality Chart (all tanks in a system, date range) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetSystemWaterQualityChartQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly systemId: string,
    public readonly fromDate: Date,
    public readonly toDate: Date,
  ) {}
}
