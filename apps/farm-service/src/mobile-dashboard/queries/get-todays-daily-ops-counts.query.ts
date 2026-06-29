/**
 * Get Today's Daily-Ops Counts Query
 */
import { IQuery } from '@platform/cqrs';

export class GetTodaysDailyOpsCountsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly clientDate?: string,
  ) {}
}
