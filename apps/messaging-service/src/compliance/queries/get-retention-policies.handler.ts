import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';

import { GetRetentionPoliciesQuery } from './get-retention-policies.query';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import { RetentionPolicyService } from '../services/retention-policy.service';

/**
 * Handler for GetRetentionPoliciesQuery.
 *
 * Returns all retention policies for the given tenant, including
 * the tenant-level default and any channel-level overrides.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */
@QueryHandler(GetRetentionPoliciesQuery)
export class GetRetentionPoliciesHandler
  implements IQueryHandler<GetRetentionPoliciesQuery, RetentionPolicy[]>
{
  private readonly logger = new Logger(GetRetentionPoliciesHandler.name);

  constructor(private readonly retentionService: RetentionPolicyService) {}

  async execute(query: GetRetentionPoliciesQuery): Promise<RetentionPolicy[]> {
    const policies = await this.retentionService.getPolicies(query.tenantId);

    this.logger.debug(
      `GetRetentionPolicies: tenant=${query.tenantId}, count=${policies.length}`,
    );

    return policies;
  }
}
