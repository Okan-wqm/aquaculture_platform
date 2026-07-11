import type { FinanceGranularity } from '../services/finance-ledger-query.service';

export class GetFinanceSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly from: Date,
    public readonly to: Date,
    public readonly granularity: FinanceGranularity,
  ) {}
}
