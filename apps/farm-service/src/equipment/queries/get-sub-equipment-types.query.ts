/**
 * Get SubEquipment Types Query
 */
export interface SubEquipmentTypeFilter {
  compatibleWithEquipmentType?: string;
  isActive?: boolean;
  search?: string;
}

export class GetSubEquipmentTypesQuery {
  constructor(
    public readonly filter?: SubEquipmentTypeFilter,
  ) {}
}
