/**
 * Chemical GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, SkipTenantGuard, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { ChemicalResponse, PaginatedChemicalsResponse, ChemicalTypeResponse } from './dto/chemical.response';
import { CreateChemicalInput } from './dto/create-chemical.input';
import { UpdateChemicalInput } from './dto/update-chemical.input';
import { ChemicalFilterInput } from './dto/chemical-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateChemicalCommand, CreateChemicalInput as CreateChemicalInputDto } from './commands/create-chemical.command';
import { UpdateChemicalCommand, UpdateChemicalInput as UpdateChemicalInputDto } from './commands/update-chemical.command';
import { DeleteChemicalCommand } from './commands/delete-chemical.command';
import { AddDocumentCommand } from './commands/add-document.command';
import { RemoveDocumentCommand } from './commands/remove-document.command';
import { GetChemicalQuery } from './queries/get-chemical.query';
import { ListChemicalsQuery } from './queries/list-chemicals.query';
import { Chemical, ChemicalType } from './entities/chemical.entity';
import { ChemicalType as ChemicalTypeEntity } from './entities/chemical-type.entity';
import { AddChemicalDocumentInput } from './dto/add-document.input';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => ChemicalResponse)
@UseGuards(TenantGuard)
export class ChemicalResolver {
  private readonly logger = new Logger(ChemicalResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(ChemicalTypeEntity)
    private readonly chemicalTypeRepository: Repository<ChemicalTypeEntity>,
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    private readonly restoreService: RestoreService,
  ) {}

  /** Exact-decimal wire form of `unitPrice` (ADR-0004 / DATA-MEDIUM-009). */
  @ResolveField(() => DecimalScalar, { nullable: true })
  unitPriceDecimal(@Parent() chemical: ChemicalResponse): number | null {
    return chemical.unitPrice ?? null;
  }

  /**
   * Create a new chemical
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ChemicalResponse)
  async createChemical(
    @Args('input') input: CreateChemicalInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ChemicalResponse> {
    this.logger.log(`Creating chemical "${input.name}" for tenant ${tenantId}`);
    const command = new CreateChemicalCommand(input as CreateChemicalInputDto, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing chemical
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ChemicalResponse)
  async updateChemical(
    @Args('input') input: UpdateChemicalInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ChemicalResponse> {
    this.logger.log(`Updating chemical ${input.id} for tenant ${tenantId}`);
    const { id, ...updateData } = input;
    const command = new UpdateChemicalCommand(id, updateData as UpdateChemicalInputDto, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) a chemical
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteChemical(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting chemical ${id} for tenant ${tenantId}`);
    const command = new DeleteChemicalCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted chemical. TENANT_ADMIN only. Phase 4.2
   * of the "Farm modülü kalan kör noktalar" plan. Closes Girdi 6
   * on the chemical surface.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => ChemicalResponse)
  async restoreChemical(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Chemical> {
    this.logger.log(`Restoring chemical ${id} for tenant ${tenantId}`);
    return this.restoreService.restore(
      this.chemicalRepository,
      Chemical,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      { uniqueKeys: [['code']] },
    );
  }

  /**
   * Add a document to a chemical
   * Called after file is uploaded to MinIO
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ChemicalResponse)
  async addChemicalDocument(
    @Args('input') input: AddChemicalDocumentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ChemicalResponse> {
    this.logger.log(`Adding document to chemical ${input.chemicalId} for tenant ${tenantId}`);
    const command = new AddDocumentCommand(
      input.chemicalId,
      {
        documentId: input.documentId,
        documentName: input.documentName,
        documentType: input.documentType,
        url: input.url,
        uploadedAt: input.uploadedAt,
        uploadedBy: user.sub,
      },
      tenantId,
      user.sub,
    );
    return this.commandBus.execute(command);
  }

  /**
   * Remove a document from a chemical
   * Should also delete the file from MinIO (handled by caller)
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async removeChemicalDocument(
    @Args('chemicalId', { type: () => ID }) chemicalId: string,
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Removing document ${documentId} from chemical ${chemicalId} for tenant ${tenantId}`);
    const command = new RemoveDocumentCommand(chemicalId, documentId, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get a single chemical by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ChemicalResponse, { nullable: true })
  async chemical(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ChemicalResponse | null> {
    const query = new GetChemicalQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * List chemicals with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedChemicalsResponse)
  async chemicals(
    @Args('filter', { type: () => ChemicalFilterInput, nullable: true }) filter: ChemicalFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedChemicalsResponse> {
    const query = new ListChemicalsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<ChemicalResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get chemicals by type for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ChemicalResponse])
  async chemicalsByType(
    @Args('type', { type: () => ChemicalType }) type: ChemicalType,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly ChemicalResponse[]> {
    const query = new ListChemicalsQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<ChemicalResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get treatment chemicals for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ChemicalResponse])
  async treatmentChemicals(
    @CurrentTenant() tenantId: string,
  ): Promise<readonly ChemicalResponse[]> {
    const query = new ListChemicalsQuery(
      tenantId,
      { type: ChemicalType.TREATMENT, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<ChemicalResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get disinfectant chemicals for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ChemicalResponse])
  async disinfectantChemicals(
    @CurrentTenant() tenantId: string,
  ): Promise<readonly ChemicalResponse[]> {
    const query = new ListChemicalsQuery(
      tenantId,
      { type: ChemicalType.DISINFECTANT, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<ChemicalResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get all chemical types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ChemicalTypeResponse])
  async chemicalTypes(): Promise<ChemicalTypeResponse[]> {
    return this.chemicalTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}
