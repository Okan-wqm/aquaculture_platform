/**
 * GetHarvestQuery
 *
 * Query for retrieving a single harvest record by ID.
 *
 * @module Harvest/Queries
 */

export class GetHarvestQuery {
  constructor(
    public readonly tenantId: string,
    public readonly harvestRecordId: string,
  ) {}
}
