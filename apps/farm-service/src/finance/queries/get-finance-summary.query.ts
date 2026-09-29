import type { FinanceGranularity } from '../services/finance-ledger-model';
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetFinanceSummaryQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly from: Date,
    public readonly to: Date,
    public readonly granularity: FinanceGranularity,
  ) {}
}
