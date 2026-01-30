/**
 * GetHarvestStatisticsQuery
 *
 * Query for retrieving harvest statistics for a tenant within a date range.
 *
 * @module Harvest/Queries
 */

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export class GetHarvestStatisticsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly dateRange: DateRange,
  ) {}
}
