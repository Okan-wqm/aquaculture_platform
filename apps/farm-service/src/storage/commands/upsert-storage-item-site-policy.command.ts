import type { UpsertStorageItemSitePolicyInput } from '../dto/storage-item-site-policy.input';

/** Create or change the per-site minimum of one item (plan K8 tier 1). */
export class UpsertStorageItemSitePolicyCommand {
  constructor(
    public readonly input: UpsertStorageItemSitePolicyInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
