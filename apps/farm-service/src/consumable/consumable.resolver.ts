/**
 * Consumable GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser, fromCqrsPaginated } from '@platform/backend-common';
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

@Resolver(() => ConsumableResponse)
@UseGuards(TenantGuard)
export class ConsumableResolver {
  private readonly logger = new Logger(ConsumableResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

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

  @Mutation(() => ConsumableResponse)
  async updateConsumable(
    @Args('input') input: UpdateConsumableInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ConsumableResponse> {
    this.logger.log(`Updating consumable ${input.id} for tenant ${tenantId}`);
    const { id, ...updateData } = input;
    const command = new UpdateConsumableCommand(id, updateData as any, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

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

  @Query(() => ConsumableResponse, { nullable: true })
  async consumable(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ConsumableResponse | null> {
    const query = new GetConsumableQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Query(() => PaginatedConsumablesResponse)
  async consumables(
    @Args('filter', { type: () => ConsumableFilterInput, nullable: true }) filter: ConsumableFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedConsumablesResponse> {
    const query = new ListConsumablesQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query);
    return fromCqrsPaginated(result);
  }
}
