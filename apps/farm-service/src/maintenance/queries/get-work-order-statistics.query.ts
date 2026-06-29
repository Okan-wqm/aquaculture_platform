/**
 * Get Work Order Statistics Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWorkOrderStatisticsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly dateFrom?: Date,
    public readonly dateTo?: Date,
  ) {}
}
