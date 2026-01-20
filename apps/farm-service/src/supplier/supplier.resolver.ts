/**
 * Supplier GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantGuard, CurrentTenant, CurrentUser, SkipTenantGuard } from '@platform/backend-common';
import { SupplierResponse, PaginatedSuppliersResponse, SupplierTypeResponse } from './dto/supplier.response';
import { CreateSupplierInput } from './dto/create-supplier.input';
import { UpdateSupplierInput } from './dto/update-supplier.input';
import { SupplierFilterInput } from './dto/supplier-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateSupplierCommand } from './commands/create-supplier.command';
import { UpdateSupplierCommand } from './commands/update-supplier.command';
import { DeleteSupplierCommand } from './commands/delete-supplier.command';
import { GetSupplierQuery } from './queries/get-supplier.query';
import { ListSuppliersQuery } from './queries/list-suppliers.query';
import { SupplierType } from './entities/supplier.entity';
import { SupplierType as SupplierTypeEntity } from './entities/supplier-type.entity';

@Resolver(() => SupplierResponse)
@UseGuards(TenantGuard)
export class SupplierResolver {
  private readonly logger = new Logger(SupplierResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(SupplierTypeEntity)
    private readonly supplierTypeRepository: Repository<SupplierTypeEntity>,
  ) {}

  /**
   * Create a new supplier
   */
  @Mutation(() => SupplierResponse)
  async createSupplier(
    @Args('input') input: CreateSupplierInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SupplierResponse> {
    this.logger.log(`Creating supplier "${input.name}" for tenant ${tenantId}`);
    const command = new CreateSupplierCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing supplier
   */
  @Mutation(() => SupplierResponse)
  async updateSupplier(
    @Args('input') input: UpdateSupplierInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SupplierResponse> {
    this.logger.log(`Updating supplier ${input.id} for tenant ${tenantId}`);
    const command = new UpdateSupplierCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) a supplier
   */
  @Mutation(() => Boolean)
  async deleteSupplier(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting supplier ${id} for tenant ${tenantId}`);
    const command = new DeleteSupplierCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get a single supplier by ID
   */
  @Query(() => SupplierResponse, { nullable: true })
  async supplier(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse | null> {
    const query = new GetSupplierQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * List suppliers with pagination and filtering
   */
  @Query(() => PaginatedSuppliersResponse)
  async suppliers(
    @Args('filter', { type: () => SupplierFilterInput, nullable: true }) filter: SupplierFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedSuppliersResponse> {
    const query = new ListSuppliersQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get suppliers by type for dropdowns
   */
  @Query(() => [SupplierResponse])
  async suppliersByType(
    @Args('type', { type: () => SupplierType }) type: SupplierType,
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse[]> {
    const query = new ListSuppliersQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get equipment suppliers for dropdowns
   */
  @Query(() => [SupplierResponse])
  async equipmentSuppliers(
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse[]> {
    const query = new ListSuppliersQuery(tenantId, { type: SupplierType.EQUIPMENT, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get feed suppliers for dropdowns
   */
  @Query(() => [SupplierResponse])
  async feedSuppliers(
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse[]> {
    const query = new ListSuppliersQuery(tenantId, { type: SupplierType.FEED, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get chemical suppliers for dropdowns
   */
  @Query(() => [SupplierResponse])
  async chemicalSuppliers(
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse[]> {
    const query = new ListSuppliersQuery(tenantId, { type: SupplierType.CHEMICAL, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get all supplier types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Query(() => [SupplierTypeResponse])
  async supplierTypes(): Promise<SupplierTypeResponse[]> {
    return this.supplierTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}
