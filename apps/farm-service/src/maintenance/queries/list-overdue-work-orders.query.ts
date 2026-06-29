/**
 * List Overdue Work Orders Query
 */
import { IQuery } from '@platform/cqrs';

export class ListOverdueWorkOrdersQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
