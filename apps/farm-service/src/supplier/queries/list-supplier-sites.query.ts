/**
 * ListSupplierSitesQuery — Scope A Phase 4.4.2.
 *
 * Returns the full set of `SupplierSite` rows for one supplier in the
 * caller's tenant. Used both by the dedicated `supplierSites(supplierId)`
 * resolver query and by the `Supplier.approvedSites` field resolver.
 */
export class ListSupplierSitesQuery {
  constructor(
    public readonly supplierId: string,
    public readonly tenantId: string,
  ) {}
}
