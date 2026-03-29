import { IQuery } from '@nestjs/cqrs';

/**
 * Query to retrieve all retention policies for a tenant.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */
export class GetRetentionPoliciesQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
