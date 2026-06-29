/**
 * InventoryCountResponse field resolver.
 *
 * Adds the `locationName` field to InventoryCountResponse as a single SSoT for
 * EVERY operation that returns it (the inventoryCounts list, the inventoryCount
 * single query, and the create/updateItems/submit/approve mutations) — the FE
 * COUNT_FIELDS selection set requires `locationName`, and without this field the
 * whole inventory-count feature failed GraphQL validation.
 *
 * Resolving here (rather than populating in each of the ~6 handlers that build
 * an InventoryCountResponse) keeps the join in one place. It is an N+1 over a
 * counts page; inventory-count lists are small, and the lookup goes through the
 * fail-closed tenant boundary. A DataLoader batch can replace it if a page ever
 * grows large.
 */
import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { CurrentTenant } from '@aquaculture/backend-common/decorators';

import { InventoryCountResponse } from '../dto/inventory-count.response';
import { GetStorageLocationNameQuery } from '../queries/get-storage-location-name.query';

@Resolver(() => InventoryCountResponse)
export class InventoryCountResponseResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @ResolveField(() => String, { nullable: true })
  async locationName(
    @Parent() count: InventoryCountResponse,
    @CurrentTenant() tenantId: string,
  ): Promise<string | null> {
    return this.queryBus.execute<GetStorageLocationNameQuery, string | null>(
      new GetStorageLocationNameQuery(tenantId, count.storageLocationId),
    );
  }
}
