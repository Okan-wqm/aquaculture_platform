import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

export class GetStorageOverviewQuery {
  constructor(
    public readonly tenantId: string,
    /** Scopes SITE low-stock rows to the caller's sites (plan K8). */
    public readonly caller: SiteScopeCaller,
  ) {}
}
