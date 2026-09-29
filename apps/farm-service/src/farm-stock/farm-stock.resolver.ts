import { Args, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { FarmStockInventoryConnection, FarmStockInventoryFilterInput } from './dto/farm-stock-inventory.dto';
import { GetFarmStockInventoryQuery } from './queries/get-farm-stock-inventory.query';
import { FarmTenantScopes } from '../common/tenant-boundary/farm-tenant-scopes';

@Resolver()
export class FarmStockResolver {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly tenantScopes: FarmTenantScopes,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FarmStockInventoryConnection, { name: 'farmStockInventory' })
  async farmStockInventory(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => FarmStockInventoryFilterInput, nullable: true })
    filter?: FarmStockInventoryFilterInput,
  ): Promise<FarmStockInventoryConnection> {
    return this.tenantScopes.read(tenantId, (scope) =>
      this.queryBus.execute(new GetFarmStockInventoryQuery(scope, filter ?? {})),
    );
  }
}
