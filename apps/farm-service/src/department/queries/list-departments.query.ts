/**
 * List Departments Query
 */
import { DepartmentType, DepartmentStatus } from '../entities/department.entity';

export interface DepartmentFilter {
  siteId?: string;
  type?: DepartmentType;
  status?: DepartmentStatus;
  isActive?: boolean;
  search?: string;
}

export interface DepartmentPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListDepartmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: DepartmentFilter,
    public readonly pagination?: DepartmentPagination,
  ) {}
}
