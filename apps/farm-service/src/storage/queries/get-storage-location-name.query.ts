/**
 * Get Storage-Location Name Query — resolves a location's display name (or null
 * if the location no longer exists). Used by the InventoryCountResponse
 * locationName field resolver; nullable-by-design so a deleted location does not
 * crash an otherwise-valid inventory-count response.
 */
import { IQuery } from '@platform/cqrs';

export class GetStorageLocationNameQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly locationId: string,
  ) {}
}
