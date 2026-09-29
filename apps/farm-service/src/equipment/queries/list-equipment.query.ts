/**
 * List Equipment Query
 */
import { EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentCategory } from '../entities/equipment-type.entity';
import type { TenantScope } from '@aquaculture/backend-common/database';

export interface EquipmentFilter {
  departmentId?: string;
  siteId?: string;
  systemId?: string;
  parentEquipmentId?: string;
  rootOnly?: boolean;
  equipmentTypeId?: string;
  status?: EquipmentStatus;
  isActive?: boolean;
  search?: string;
  hasWarranty?: boolean;
  isVisibleInSensor?: boolean;
  isTank?: boolean;
  categories?: EquipmentCategory[];
}

export interface EquipmentPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListEquipmentQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly filter?: EquipmentFilter,
    public readonly pagination?: EquipmentPagination,
  ) {}
}
