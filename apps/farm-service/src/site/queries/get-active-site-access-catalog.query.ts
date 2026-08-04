import { IQuery } from '@platform/cqrs';

/** Tenant-wide active Site catalog for manager-class access administration. */
export class GetActiveSiteAccessCatalogQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
