/**
 * List Chemicals Query
 */
import { ChemicalType, ChemicalStatus } from '../entities/chemical.entity';

export interface ChemicalFilter {
  type?: ChemicalType;
  status?: ChemicalStatus;
  supplierId?: string;
  siteId?: string;
  isActive?: boolean;
  search?: string;
}

export interface ChemicalPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListChemicalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: ChemicalFilter,
    public readonly pagination?: ChemicalPagination,
  ) {}
}
