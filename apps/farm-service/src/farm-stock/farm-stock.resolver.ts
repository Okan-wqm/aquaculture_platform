import { Args, Query, Resolver } from '@nestjs/graphql';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { FarmStockInventoryConnection, FarmStockInventoryFilterInput } from './dto/farm-stock-inventory.dto';
import { FarmStockService } from './farm-stock.service';

@Resolver()
export class FarmStockResolver {
  constructor(private readonly farmStockService: FarmStockService) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FarmStockInventoryConnection, { name: 'farmStockInventory' })
  async farmStockInventory(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => FarmStockInventoryFilterInput, nullable: true })
    filter?: FarmStockInventoryFilterInput,
  ): Promise<FarmStockInventoryConnection> {
    return this.farmStockService.listInventory(tenantId, filter ?? {});
  }
}
