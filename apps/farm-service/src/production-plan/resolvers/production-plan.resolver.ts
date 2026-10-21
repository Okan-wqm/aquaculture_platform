/**
 * Production-plan resolver — temperature scenarios + tank growth projection.
 *
 * GraphQL types live in dto/ (code-first ObjectType/Inputs) so the wire
 * contract stays beside the domain, like the other farm resolvers.
 */
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { Roles, Role, CurrentTenant, CurrentUser } from '@aquaculture/backend-common/decorators';

import { GetTemperatureScenariosQuery } from '../queries/get-temperature-scenarios.query';
import { CreateTemperatureScenarioQuery } from '../queries/create-temperature-scenario.query';
import { DeleteTemperatureScenarioQuery } from '../queries/delete-temperature-scenario.query';
import { GetTankGrowthProjectionQuery } from '../queries/get-tank-growth-projection.query';
import { TemperatureScenarioResponse } from '../entities/temperature-scenario.entity';
import {
  CreateTemperatureScenarioInput,
  TankGrowthProjectionInput,
  TankGrowthProjectionResponse,
} from '../dto/production-plan.dto';

@Resolver()
export class ProductionPlanResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [TemperatureScenarioResponse], { name: 'temperatureScenarios' })
  async temperatureScenarios(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
  ): Promise<TemperatureScenarioResponse[]> {
    return this.queryBus.execute(new GetTemperatureScenariosQuery(tenantId, siteId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => TemperatureScenarioResponse)
  async createTemperatureScenario(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: CreateTemperatureScenarioInput,
  ): Promise<TemperatureScenarioResponse> {
    return this.queryBus.execute(
      new CreateTemperatureScenarioQuery(
        tenantId,
        input.siteId,
        input.name,
        input.points,
        user.sub,
      ),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => Boolean)
  async deleteTemperatureScenario(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.queryBus.execute(new DeleteTemperatureScenarioQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [TankGrowthProjectionResponse], { name: 'tankGrowthProjection' })
  async tankGrowthProjection(
    @CurrentTenant() tenantId: string,
    @Args('input', { nullable: true }) input?: TankGrowthProjectionInput,
  ): Promise<TankGrowthProjectionResponse[]> {
    return this.queryBus.execute(
      new GetTankGrowthProjectionQuery(tenantId, {
        siteId: input?.siteId,
        departmentId: input?.departmentId,
        horizonDays: input?.horizonDays ?? 30,
        scenarioId: input?.scenarioId,
      }),
    );
  }
}
