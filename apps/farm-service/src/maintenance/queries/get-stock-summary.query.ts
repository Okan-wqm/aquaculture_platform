/**
 * Get Spare-Part Stock Summary Query
 */
import { IQuery } from '@platform/cqrs';

export class GetStockSummaryQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
