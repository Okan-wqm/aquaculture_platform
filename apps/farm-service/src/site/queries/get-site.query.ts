/**
 * Get Site Query
 */
import { IQuery } from '@platform/cqrs';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

export class GetSiteQuery implements IQuery {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
    public readonly caller: SiteScopeCaller,
    public readonly includeRelations?: boolean,
  ) {}
}
