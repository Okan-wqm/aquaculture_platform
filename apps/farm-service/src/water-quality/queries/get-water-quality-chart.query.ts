/**
 * Get Water Quality Chart (single tank, date range) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWaterQualityChartQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
    public readonly fromDate: Date,
    public readonly toDate: Date,
  ) {}
}
