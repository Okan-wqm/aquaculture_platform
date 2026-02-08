import { ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';

export interface ConsumableFilter {
  category?: ConsumableCategory;
  status?: ConsumableStatus;
  supplierId?: string;
  isActive?: boolean;
  search?: string;
}

export interface ConsumablePagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListConsumablesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: ConsumableFilter,
    public readonly pagination?: ConsumablePagination,
  ) {}
}
