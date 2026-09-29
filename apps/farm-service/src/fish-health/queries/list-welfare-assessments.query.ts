/**
 * List welfare assessments, optionally narrowed to a site/tank and an
 * assessment date window (inclusive ISO dates).
 */
import type { TenantScope } from '@aquaculture/backend-common/database';
export class ListWelfareAssessmentsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly siteId?: string,
    public readonly tankId?: string,
    public readonly fromDate?: string,
    public readonly toDate?: string,
  ) {}
}
