/**
 * List Work Orders (filtered, paginated) Query
 */
import { IQuery } from '@platform/cqrs';
import { WorkOrderFilterInput } from '../dto/work-order-filter.dto';

export class ListWorkOrdersQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: WorkOrderFilterInput,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'createdAt',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
