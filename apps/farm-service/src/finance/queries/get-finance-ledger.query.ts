import type { FinanceCategoryScope } from '../entities/finance-category.entity';

export class GetFinanceLedgerQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter: {
      from?: Date;
      to?: Date;
      scope?: FinanceCategoryScope;
      categoryId?: string;
      batchId?: string;
      siteId?: string;
      includeDerived: boolean;
      limit: number;
      offset: number;
    },
  ) {}
}
