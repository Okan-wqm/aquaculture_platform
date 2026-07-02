/**
 * List Spare Parts compatible with an equipment type Query
 */
import { IQuery } from '@platform/cqrs';

export class ListSparePartsByEquipmentTypeQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly equipmentTypeId: string,
  ) {}
}
