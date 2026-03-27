/**
 * ListParamEquipmentQuery
 *
 * Lists parameter-equipment mappings with optional filters.
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Filter options for parameter-equipment mappings
 */
export interface ParamEquipmentFilter {
  equipmentId?: string;
  parameterConfigId?: string;
  isActive?: boolean;
}

export class ListParamEquipmentQuery implements ITenantQuery {
  readonly queryName = 'ListParamEquipmentQuery';

  constructor(
    public readonly tenantId: string,
    public readonly filters?: ParamEquipmentFilter,
  ) {}
}
