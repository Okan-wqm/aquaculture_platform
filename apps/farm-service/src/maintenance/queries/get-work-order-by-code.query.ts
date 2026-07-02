/**
 * Get Work Order (by code) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWorkOrderByCodeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly code: string,
  ) {}
}
