/**
 * SetSupplierApprovedSitesCommand — Scope A Phase 4.4.2.
 *
 * Replaces the FULL set of sites a supplier is approved to deliver
 * to. Semantics are intentionally "set, not append" so the handler
 * can run a clean DELETE+INSERT inside a single transaction without
 * juggling per-row diffs.
 *
 * The optional `preferredSiteId` (must appear in `siteIds`) flips
 * the `isPreferred` flag on exactly one row. If null, no row is
 * preferred. The handler enforces "preferredSiteId ∈ siteIds" so
 * orphan preferences cannot land.
 */
export class SetSupplierApprovedSitesCommand {
  constructor(
    public readonly supplierId: string,
    public readonly siteIds: readonly string[],
    public readonly preferredSiteId: string | null,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
