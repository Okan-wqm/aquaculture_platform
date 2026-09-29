import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

import type { StorageItemSitePolicyFilterInput } from '../dto/storage-item-site-policy.input';

/**
 * List per-site stock policies. `caller` scopes the rows to the sites the
 * caller may see (managers: every site; others: their assigned sites).
 */
export class ListStorageItemSitePoliciesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly caller: SiteScopeCaller,
    public readonly filter: StorageItemSitePolicyFilterInput,
  ) {}
}
