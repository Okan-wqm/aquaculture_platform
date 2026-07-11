/**
 * HR finance query classes (one file — hr-service groups small query
 * classes per domain, mirroring hr/queries/*).
 */
import type { HrFinanceGranularity } from '../query-handlers/get-hr-finance-summary.handler';

export class GetHrLabourCostQuery {
  constructor(
    public readonly tenantId: string,
    /** Calendar year the actual payroll/expense YTD figures cover. */
    public readonly year: number,
  ) {}
}

export class GetHrFinanceSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly from: Date,
    public readonly to: Date,
    public readonly granularity: HrFinanceGranularity,
  ) {}
}

export class GetHrFinanceCategoriesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly includeArchived: boolean = false,
  ) {}
}

export class GetHrFinanceEntriesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter: {
      from?: Date;
      to?: Date;
      categoryId?: string;
      departmentHrId?: string;
      limit: number;
      offset: number;
    },
  ) {}
}

export class GetPayrollCostSettingsQuery {
  constructor(public readonly tenantId: string) {}
}
