/**
 * GetEquipmentParamsQuery
 *
 * Retrieves all parameter mappings for a specific equipment item.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetEquipmentParamsQuery implements ITenantQuery {
  readonly queryName = 'GetEquipmentParamsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly equipmentId: string,
  ) {}
}
