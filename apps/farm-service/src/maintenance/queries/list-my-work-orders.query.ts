/**
 * List My Work Orders (assigned to a user) Query
 */
import { IQuery } from '@platform/cqrs';

export class ListMyWorkOrdersQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly activeOnly: boolean = true,
  ) {}
}
