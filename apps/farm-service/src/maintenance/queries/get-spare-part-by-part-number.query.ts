/**
 * Get Spare Part (by part number) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetSparePartByPartNumberQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly partNumber: string,
  ) {}
}
