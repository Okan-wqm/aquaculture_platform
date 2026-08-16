import { TenantStatus, TenantPlan } from '../entities/tenant.entity';
import type { AdminSqlIdentifierKey } from '@platform/admin-http-contracts';

export class GetTenantByIdQuery {
  constructor(public readonly tenantId: string) {}
}

export class GetTenantBySlugQuery {
  constructor(public readonly slug: string) {}
}

export class ListTenantsQuery {
  constructor(
    public readonly filter?: {
      status?: TenantStatus;
      plan?: TenantPlan;
      search?: string;
    },
    public readonly pagination?: {
      page: number;
      limit: number;
    },
    public readonly sort?: {
      field: AdminSqlIdentifierKey<'GET /admin/tenants'>;
      order: 'ASC' | 'DESC';
    },
  ) {}
}

export class GetTenantStatsQuery {
  constructor() {}
}

export class GetTenantUsageQuery {
  constructor(public readonly tenantId: string) {}
}

export class GetTenantActivityQuery {
  constructor(
    public readonly tenantId: string,
    public readonly startDate?: Date,
    public readonly endDate?: Date,
  ) {}
}

export class GetTenantsApproachingLimitsQuery {
  constructor(
    public readonly thresholdPercentage = 80,
    public readonly limitType?: 'users',
  ) {}
}

export class GetExpiringTrialsQuery {
  constructor(public readonly withinDays = 7) {}
}

export class SearchTenantsQuery {
  constructor(
    public readonly searchTerm: string,
    public readonly limit = 20,
  ) {}
}
