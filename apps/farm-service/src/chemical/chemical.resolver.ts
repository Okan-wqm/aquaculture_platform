/**
 * Chemical GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantGuard, CurrentTenant, CurrentUser, SkipTenantGuard } from '@platform/backend-common';
import { ChemicalResponse, PaginatedChemicalsResponse, ChemicalTypeResponse } from './dto/chemical.response';
import { CreateChemicalInput } from './dto/create-chemical.input';
import { UpdateChemicalInput } from './dto/update-chemical.input';
import { ChemicalFilterInput } from './dto/chemical-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateChemicalCommand } from './commands/create-chemical.command';
import { UpdateChemicalCommand } from './commands/update-chemical.command';
import { DeleteChemicalCommand } from './commands/delete-chemical.command';
import { AddDocumentCommand } from './commands/add-document.command';
import { RemoveDocumentCommand } from './commands/remove-document.command';
import { GetChemicalQuery } from './queries/get-chemical.query';
import { ListChemicalsQuery } from './queries/list-chemicals.query';
import { ChemicalType } from './entities/chemical.entity';
import { ChemicalType as ChemicalTypeEntity } from './entities/chemical-type.entity';
import { AddChemicalDocumentInput } from './dto/add-document.input';

@Resolver(() => ChemicalResponse)
@UseGuards(TenantGuard)
export class ChemicalResolver {
  private readonly logger = new Logger(ChemicalResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(ChemicalTypeEntity)
    private readonly chemicalTypeRepository: Repository<ChemicalTypeEntity>,
  ) {}

  /**
   * Create a new chemical
   */
  @Mutation(() => ChemicalResponse)
  async createChemical(
    @Args('input') input: CreateChemicalInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ChemicalResponse> {
    this.logger.log(`Creating chemical "${input.name}" for tenant ${tenantId}`);
    const command = new CreateChemicalCommand(input as any, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing chemical
   */
  @Mutation(() => ChemicalResponse)
  async updateChemical(
    @Args('input') input: UpdateChemicalInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ChemicalResponse> {
    this.logger.log(`Updating chemical ${input.id} for tenant ${tenantId}`);
    const { id, ...updateData } = input;
    const command = new UpdateChemicalCommand(id, updateData as any, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) a chemical
   */
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
   * Add a document to a chemical
   * Called after file is uploaded to MinIO
   */
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
  @Query(() => PaginatedChemicalsResponse)
  async chemicals(
    @Args('filter', { type: () => ChemicalFilterInput, nullable: true }) filter: ChemicalFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedChemicalsResponse> {
    const query = new ListChemicalsQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get chemicals by type for dropdowns
   */
  @Query(() => [ChemicalResponse])
  async chemicalsByType(
    @Args('type', { type: () => ChemicalType }) type: ChemicalType,
    @CurrentTenant() tenantId: string,
  ): Promise<ChemicalResponse[]> {
    const query = new ListChemicalsQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get treatment chemicals for dropdowns
   */
  @Query(() => [ChemicalResponse])
  async treatmentChemicals(
    @CurrentTenant() tenantId: string,
  ): Promise<ChemicalResponse[]> {
    const query = new ListChemicalsQuery(tenantId, { type: ChemicalType.TREATMENT, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get disinfectant chemicals for dropdowns
   */
  @Query(() => [ChemicalResponse])
  async disinfectantChemicals(
    @CurrentTenant() tenantId: string,
  ): Promise<ChemicalResponse[]> {
    const query = new ListChemicalsQuery(tenantId, { type: ChemicalType.DISINFECTANT, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get all chemical types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Query(() => [ChemicalTypeResponse])
  async chemicalTypes(): Promise<ChemicalTypeResponse[]> {
    return this.chemicalTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}
