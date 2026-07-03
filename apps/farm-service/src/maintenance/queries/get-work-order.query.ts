/**
 * Get Work Order (by id) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWorkOrderQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
