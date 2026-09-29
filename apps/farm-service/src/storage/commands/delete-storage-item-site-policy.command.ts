/** Remove a per-site minimum; the site then has no distribution policy for the item. */
export class DeleteStorageItemSitePolicyCommand {
  constructor(
    public readonly policyId: string,
    public readonly tenantId: string,
  ) {}
}
