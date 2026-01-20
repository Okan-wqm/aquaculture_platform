/**
 * List Suppliers Query
 */
import { SupplierType, SupplierStatus } from '../entities/supplier.entity';

export interface SupplierFilter {
  type?: SupplierType;
  status?: SupplierStatus;
  isActive?: boolean;
  country?: string;
  search?: string;
}

export interface SupplierPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListSuppliersQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: SupplierFilter,
    public readonly pagination?: SupplierPagination,
  ) {}
}
