/**
 * List Spare Parts (filtered, paginated) Query
 */
import { IQuery } from '@platform/cqrs';
import { SparePartFilterInput } from '../dto/spare-part.dto';

export class ListSparePartsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: SparePartFilterInput,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'name',
    public readonly sortOrder: 'ASC' | 'DESC' = 'ASC',
  ) {}
}
