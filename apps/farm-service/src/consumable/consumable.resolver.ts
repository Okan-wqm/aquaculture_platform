/**
 * Consumable GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { ConsumableResponse, PaginatedConsumablesResponse } from './dto/consumable.response';
import { CreateConsumableInput } from './dto/create-consumable.input';
import { UpdateConsumableInput } from './dto/update-consumable.input';
import { ConsumableFilterInput } from './dto/consumable-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateConsumableCommand } from './commands/create-consumable.command';
import { UpdateConsumableCommand } from './commands/update-consumable.command';
import { DeleteConsumableCommand } from './commands/delete-consumable.command';
import { GetConsumableQuery } from './queries/get-consumable.query';
import { ListConsumablesQuery } from './queries/list-consumables.query';
import { Consumable } from './entities/consumable.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => ConsumableResponse)
@UseGuards(TenantGuard)
export class ConsumableResolver {
  private readonly logger = new Logger(ConsumableResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    private readonly restoreService: RestoreService,
  ) {}

  /** Exact-decimal wire form of `unitPrice` (ADR-0004 / DATA-MEDIUM-009). */
  @ResolveField(() => DecimalScalar, { nullable: true })
  unitPriceDecimal(@Parent() consumable: ConsumableResponse): number | null {
    return consumable.unitPrice ?? null;
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ConsumableResponse)
  async createConsumable(
    @Args('input') input: CreateConsumableInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ConsumableResponse> {
    this.logger.log(`Creating consumable "${input.name}" for tenant ${tenantId}`);
    const command = new CreateConsumableCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ConsumableResponse)
  async updateConsumable(
    @Args('input') input: UpdateConsumableInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ConsumableResponse> {
    this.logger.log(`Updating consumable ${input.id} for tenant ${tenantId}`);
    const command = new UpdateConsumableCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteConsumable(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting consumable ${id} for tenant ${tenantId}`);
    const command = new DeleteConsumableCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted consumable. TENANT_ADMIN only. Phase 4.2
   * of the "Farm modülü kalan kör noktalar" plan. Closes Girdi 6
   * on the consumable surface.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => ConsumableResponse)
  async restoreConsumable(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Consumable> {
    this.logger.log(`Restoring consumable ${id} for tenant ${tenantId}`);
    return this.restoreService.restore(
      this.consumableRepository,
      Consumable,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      { uniqueKeys: [['code']] },
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ConsumableResponse, { nullable: true })
  async consumable(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ConsumableResponse | null> {
    const query = new GetConsumableQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedConsumablesResponse)
  async consumables(
    @Args('filter', { type: () => ConsumableFilterInput, nullable: true }) filter: ConsumableFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedConsumablesResponse> {
    const query = new ListConsumablesQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<ConsumableResponse>;
    return fromCqrsPaginated(result);
  }
}
