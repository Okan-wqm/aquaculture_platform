/**
 * List Biomass Reports for a site Query
 */
import { IQuery } from '@platform/cqrs';

export class ListBiomassReportsForSiteQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    public readonly limit: number,
  ) {}
}
