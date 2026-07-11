import type { FinanceCategoryScope } from '../entities/finance-category.entity';

export class GetFinanceCategoriesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly scope?: FinanceCategoryScope,
    public readonly includeArchived: boolean = false,
  ) {}
}
