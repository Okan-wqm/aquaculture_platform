/**
 * GetBatchQuery
 *
 * Tek bir batch'i ID ile getirir.
 *
 * @module Batch/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetBatchQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
    public readonly includeRelations: boolean = true,
  ) {}
}
