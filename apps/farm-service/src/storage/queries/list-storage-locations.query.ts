import { StorageLocationType } from '../entities/storage-location.entity';

export interface StorageLocationFilter {
  type?: StorageLocationType;
  siteId?: string;
  isActive?: boolean;
  search?: string;
}

export interface StorageLocationPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListStorageLocationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: StorageLocationFilter,
    public readonly pagination?: StorageLocationPagination,
  ) {}
}
