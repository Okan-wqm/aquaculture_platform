import { TenantStatus, TenantPlan } from '../entities/tenant.entity';

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
      field: string;
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
    public readonly thresholdPercentage: number = 80,
    public readonly limitType?: 'users',
  ) {}
}

export class GetExpiringTrialsQuery {
  constructor(public readonly withinDays: number = 7) {}
}

export class SearchTenantsQuery {
  constructor(
    public readonly searchTerm: string,
    public readonly limit: number = 20,
  ) {}
}
