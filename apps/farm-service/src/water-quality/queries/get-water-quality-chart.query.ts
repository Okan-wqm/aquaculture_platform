/**
 * Get Water Quality Chart (single unit: a tank or water equipment, date range) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWaterQualityChartQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly unitId: string,
    public readonly fromDate: Date,
    public readonly toDate: Date,
  ) {}
}
