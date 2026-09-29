/**
 * Restore a soft-deleted site (TENANT_ADMIN). Does not cascade to the site's
 * previously deleted children; each is restored explicitly.
 */
export class RestoreSiteCommand {
  constructor(
    public readonly siteId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Display name for the audit trail. */
    public readonly userName?: string,
  ) {}
}
