/**
 * List Health Events for a batch Query
 */
import { IQuery } from '@platform/cqrs';

export class ListHealthEventsByBatchQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly activeOnly: boolean = false,
  ) {}
}
