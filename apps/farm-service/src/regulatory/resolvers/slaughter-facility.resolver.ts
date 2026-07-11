/**
 * Slaughter Facility Resolver — catalog surface for the setup UI and the
 * slakt report facility dropdown.
 */
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CurrentTenant, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { QueryBus } from '@platform/cqrs';

import { SlaughterFacility } from '../entities/slaughter-facility.entity';
import {
  CreateSlaughterFacilityInput,
  UpdateSlaughterFacilityInput,
} from '../dto/slaughter-facility.inputs';
import { ListSlaughterFacilitiesQuery } from '../queries/list-slaughter-facilities.query';
import { SlaughterFacilityService } from '../services/slaughter-facility.service';

@Resolver(() => SlaughterFacility)
@UseGuards(TenantGuard)
export class SlaughterFacilityResolver {
  constructor(
    private readonly facilityService: SlaughterFacilityService,
    private readonly queryBus: QueryBus,
  ) {}

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Query(() => [SlaughterFacility], { description: 'Slaughter-facility catalog for the tenant' })
  async slaughterFacilities(
    @CurrentTenant() tenantId: string,
    @Args('includeInactive', { nullable: true, defaultValue: false }) includeInactive: boolean,
  ): Promise<SlaughterFacility[]> {
    return this.queryBus.execute(new ListSlaughterFacilitiesQuery(tenantId, includeInactive));
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => SlaughterFacility, { description: 'Add a slaughter facility to the catalog' })
  async createSlaughterFacility(
    @CurrentTenant() tenantId: string,
    @Args('input') input: CreateSlaughterFacilityInput,
  ): Promise<SlaughterFacility> {
    return this.facilityService.create(tenantId, input);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => SlaughterFacility, { description: 'Update a slaughter facility' })
  async updateSlaughterFacility(
    @CurrentTenant() tenantId: string,
    @Args('input') input: UpdateSlaughterFacilityInput,
  ): Promise<SlaughterFacility> {
    return this.facilityService.update(tenantId, input);
  }
}
