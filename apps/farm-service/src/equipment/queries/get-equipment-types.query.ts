/**
 * Get Equipment Types Query
 */
import { EquipmentCategory } from '../entities/equipment-type.entity';

export interface EquipmentTypeFilter {
  category?: EquipmentCategory;
  isActive?: boolean;
  search?: string;
}

export class GetEquipmentTypesQuery {
  constructor(
    public readonly filter?: EquipmentTypeFilter,
  ) {}
}
