/**
 * ListSiteContactsQuery — Scope A Phase 4.4.3.
 */
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

export class ListSiteContactsQuery {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
    public readonly caller: SiteScopeCaller,
  ) {}
}
