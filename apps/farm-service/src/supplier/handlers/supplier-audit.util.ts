import { SupplierSite } from '../entities/supplier-site.entity';

export function supplierSiteAuditSnapshot(row: SupplierSite): Record<string, unknown> {
  return {
    id: row.id,
    supplierId: row.supplierId,
    siteId: row.siteId,
    isPreferred: row.isPreferred,
  };
}
