/**
 * List treatment applications, optionally narrowed to a site and an
 * applied-at date window (inclusive ISO dates).
 */
import type { TenantScope } from '@aquaculture/backend-common/database';
export class ListTreatmentApplicationsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly siteId?: string,
    public readonly fromDate?: string,
    public readonly toDate?: string,
  ) {}
}
