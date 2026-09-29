import type { TenantScope } from '@aquaculture/backend-common/database';
export class GetFinanceBatchTotalsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly from: Date,
    public readonly to: Date,
  ) {}
}
