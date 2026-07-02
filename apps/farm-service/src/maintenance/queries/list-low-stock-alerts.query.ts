/**
 * List Low-Stock Alerts Query
 */
import { IQuery } from '@platform/cqrs';

export class ListLowStockAlertsQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
