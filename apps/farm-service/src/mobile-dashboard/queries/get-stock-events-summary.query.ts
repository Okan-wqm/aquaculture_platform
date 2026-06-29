/**
 * Get Stock-Events Summary Query
 */
import { IQuery } from '@platform/cqrs';

export class GetStockEventsSummaryQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly daysBack: number = 7,
  ) {}
}
