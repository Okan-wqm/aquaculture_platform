/**
 * SubEquipment GraphQL Resolver
 *
 * CRUD operations for sub-equipment (child components of main equipment).
 * Examples: inlet, outlet, feeder, fish-trap, etc.
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, SkipTenantGuard, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import {
  SubEquipmentResponse,
  PaginatedSubEquipmentResponse,
  SubEquipmentTypeResponse,
} from './dto/sub-equipment.response';
import { EquipmentResponse } from './dto/equipment.response';
import {
  CreateSubEquipmentInput,
  UpdateSubEquipmentInput,
  SubEquipmentFilterInput,
  SubEquipmentTypeFilterInput,
} from './dto/sub-equipment.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateSubEquipmentCommand } from './commands/create-sub-equipment.command';
import { UpdateSubEquipmentCommand } from './commands/update-sub-equipment.command';
import { DeleteSubEquipmentCommand } from './commands/delete-sub-equipment.command';
import { GetSubEquipmentQuery } from './queries/get-sub-equipment.query';
import { ListSubEquipmentQuery } from './queries/list-sub-equipment.query';
import { GetSubEquipmentTypesQuery } from './queries/get-sub-equipment-types.query';
import { SubEquipment } from './entities/sub-equipment.entity';

@Resolver(() => SubEquipmentResponse)
@UseGuards(TenantGuard)
export class SubEquipmentResolver {
  private readonly logger = new Logger(SubEquipmentResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Get single sub-equipment by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SubEquipmentResponse, { nullable: true, name: 'subEquipment' })
  async getSubEquipment(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false })
    includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<SubEquipmentResponse | null> {
    this.logger.debug(`Getting sub-equipment ${id} for tenant ${tenantId}`);
    const query = new GetSubEquipmentQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List sub-equipment with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedSubEquipmentResponse, { name: 'subEquipmentList' })
  async listSubEquipment(
    @Args('filter', { type: () => SubEquipmentFilterInput, nullable: true })
    filter?: SubEquipmentFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedSubEquipmentResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    this.logger.debug(`Listing sub-equipment for tenant ${tenantId}`);
    const query = new ListSubEquipmentQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SubEquipmentResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get sub-equipment for a specific parent equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SubEquipmentResponse], { name: 'subEquipmentByParent' })
  async getSubEquipmentByParent(
    @Args('parentEquipmentId', { type: () => ID }) parentEquipmentId: string,
    @Args('includeInactive', { type: () => Boolean, nullable: true, defaultValue: false })
    includeInactive: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly SubEquipmentResponse[]> {
    this.logger.debug(`Getting sub-equipment for parent ${parentEquipmentId}`);
    const filter: SubEquipmentFilterInput = {
      parentEquipmentId,
      isActive: includeInactive ? undefined : true,
    };
    const query = new ListSubEquipmentQuery(tenantId, filter, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SubEquipmentResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get all sub-equipment types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SubEquipmentTypeResponse], { name: 'subEquipmentTypes' })
  async getSubEquipmentTypes(
    @Args('filter', { type: () => SubEquipmentTypeFilterInput, nullable: true })
    filter?: SubEquipmentTypeFilterInput,
  ): Promise<SubEquipmentTypeResponse[]> {
    this.logger.debug('Getting sub-equipment types');
    const query = new GetSubEquipmentTypesQuery(filter);
    return this.queryBus.execute(query) as Promise<SubEquipmentTypeResponse[]>;
  }

  /**
   * Get sub-equipment types compatible with a specific equipment type
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SubEquipmentTypeResponse], { name: 'subEquipmentTypesForEquipment' })
  async getSubEquipmentTypesForEquipment(
    @Args('equipmentTypeCode') equipmentTypeCode: string,
  ): Promise<SubEquipmentTypeResponse[]> {
    this.logger.debug(`Getting sub-equipment types for equipment type ${equipmentTypeCode}`);
    const query = new GetSubEquipmentTypesQuery({
      compatibleWithEquipmentType: equipmentTypeCode,
      isActive: true,
    });
    return this.queryBus.execute(query) as Promise<SubEquipmentTypeResponse[]>;
  }

  /**
   * Get single sub-equipment type by ID
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SubEquipmentTypeResponse, { nullable: true, name: 'subEquipmentType' })
  async getSubEquipmentType(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<SubEquipmentTypeResponse | null> {
    const query = new GetSubEquipmentTypesQuery({ isActive: true });
    const types = await this.queryBus.execute(query) as SubEquipmentTypeResponse[];
    return types.find((t: SubEquipmentTypeResponse) => t.id === id) || null;
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Create new sub-equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => SubEquipmentResponse, { name: 'createSubEquipment' })
  async createSubEquipment(
    @Args('input') input: CreateSubEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SubEquipmentResponse> {
    this.logger.log(`Creating sub-equipment: ${input.name} for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateSubEquipmentCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update existing sub-equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => SubEquipmentResponse, { name: 'updateSubEquipment' })
  async updateSubEquipment(
    @Args('input') input: UpdateSubEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SubEquipmentResponse> {
    this.logger.log(`Updating sub-equipment: ${input.id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new UpdateSubEquipmentCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) sub-equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => Boolean, { name: 'deleteSubEquipment' })
  async deleteSubEquipment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting sub-equipment: ${id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new DeleteSubEquipmentCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  /**
   * Resolve subEquipmentType field
   */
  @ResolveField(() => SubEquipmentTypeResponse, { nullable: true })
  subEquipmentType(@Parent() subEquipment: SubEquipment): SubEquipmentTypeResponse | null {
    if (!subEquipment.subEquipmentType) return null;
    return subEquipment.subEquipmentType as SubEquipmentTypeResponse;
  }

  /**
   * Resolve parentEquipment field
   */
  @ResolveField(() => EquipmentResponse, { nullable: true })
  parentEquipment(@Parent() subEquipment: SubEquipment): EquipmentResponse | null {
    if (!subEquipment.parentEquipment) return null;
    return subEquipment.parentEquipment as EquipmentResponse;
  }
}
