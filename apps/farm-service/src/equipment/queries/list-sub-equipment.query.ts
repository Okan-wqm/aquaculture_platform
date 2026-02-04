/**
 * List SubEquipment Query
 */
import { EquipmentStatus } from '../entities/equipment.entity';

export interface SubEquipmentFilter {
  parentEquipmentId?: string;
  subEquipmentTypeId?: string;
  status?: EquipmentStatus;
  isActive?: boolean;
  search?: string;
}

export interface SubEquipmentPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListSubEquipmentQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: SubEquipmentFilter,
    public readonly pagination?: SubEquipmentPagination,
  ) {}
}
