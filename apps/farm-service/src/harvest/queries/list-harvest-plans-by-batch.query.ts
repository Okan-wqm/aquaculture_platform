/**
 * List Harvest Plans for a batch Query
 */
import { IQuery } from '@platform/cqrs';

export class ListHarvestPlansByBatchQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly activeOnly: boolean = false,
  ) {}
}
