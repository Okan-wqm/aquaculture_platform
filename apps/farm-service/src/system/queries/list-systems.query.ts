/**
 * List Systems Query
 */
import { SystemType, SystemStatus } from '../entities/system.entity';

export interface SystemFilter {
  siteId?: string;
  departmentId?: string;
  parentSystemId?: string;
  type?: SystemType;
  status?: SystemStatus;
  isActive?: boolean;
  rootOnly?: boolean;
  search?: string;
}

export interface SystemPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListSystemsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: SystemFilter,
    public readonly pagination?: SystemPagination,
  ) {}
}
