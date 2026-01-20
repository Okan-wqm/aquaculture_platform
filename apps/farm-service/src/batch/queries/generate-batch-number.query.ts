/**
 * GenerateBatchNumberQuery
 *
 * Generates the next sequential batch number for a tenant.
 * Format: B-YYYY-NNNNN (e.g., B-2024-00001)
 *
 * @module Batch/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GenerateBatchNumberQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
  ) {}
}
