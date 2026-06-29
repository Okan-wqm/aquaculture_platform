import { Args, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { FarmStockInventoryConnection, FarmStockInventoryFilterInput } from './dto/farm-stock-inventory.dto';
import { GetFarmStockInventoryQuery } from './queries/get-farm-stock-inventory.query';

@Resolver()
export class FarmStockResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FarmStockInventoryConnection, { name: 'farmStockInventory' })
  async farmStockInventory(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => FarmStockInventoryFilterInput, nullable: true })
    filter?: FarmStockInventoryFilterInput,
  ): Promise<FarmStockInventoryConnection> {
    return this.queryBus.execute(new GetFarmStockInventoryQuery(tenantId, filter ?? {}));
  }
}
