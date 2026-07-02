/**
 * Get Spare Part (by id) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetSparePartQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
