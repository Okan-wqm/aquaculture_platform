/** Remove a per-site minimum; the site then has no distribution policy for the item. */
export class DeleteStorageItemSitePolicyCommand {
  constructor(
    public readonly policyId: string,
    public readonly tenantId: string,
    /** The actor, recorded in farm_audit_logs (the hard delete removes the row's own stamps). */
    public readonly userId: string,
  ) {}
}
