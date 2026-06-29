/**
 * Get Spare Part (by code) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetSparePartByCodeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly code: string,
  ) {}
}
