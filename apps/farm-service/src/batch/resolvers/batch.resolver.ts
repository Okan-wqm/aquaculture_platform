/**
 * Batch GraphQL Resolver
 *
 * IP-3: DTO types extracted to batch-resolver.dto.ts (560 lines → separate file).
 * This resolver now contains only query/mutation/field-resolver logic (~300 lines).
 *
 * @module Batch/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ResolveField,
  Parent,
  registerEnumType,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Tenant, CurrentUser, Roles, Role, fromCqrsPaginated } from '@aquaculture/backend-common';
import { Batch, BatchStatus, BatchInputType } from '../entities/batch.entity';

/**
 * User context interface for CurrentUser decorator
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// Commands
import { CreateBatchCommand, CreateBatchPayload } from '../commands/create-batch.command';
import { UpdateBatchCommand, UpdateBatchPayload } from '../commands/update-batch.command';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { RecordMortalityCommand, RecordMortalityPayload, MortalityReason } from '../commands/record-mortality.command';
import { RecordCullCommand, RecordCullPayload, CullReason } from '../commands/record-cull.command';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { AllocateToTankCommand, AllocateToTankPayload, AllocationType } from '../commands/allocate-to-tank.command';
import { TransferBatchCommand, TransferBatchPayload } from '../commands/transfer-batch.command';

// Queries
import { GetBatchQuery } from '../queries/get-batch.query';
import { ListBatchesQuery, BatchFilterInput as BatchFilter } from '../queries/list-batches.query';
import { ListAvailableTanksQuery, AvailableTank } from '../queries/list-available-tanks.query';
import { GenerateBatchNumberQuery } from '../queries/generate-batch-number.query';
import { GetBatchPerformanceQuery, BatchPerformanceResult } from '../queries/get-batch-performance.query';
import { GetBatchHistoryQuery, BatchHistoryEntry, BatchHistoryEventType } from '../queries/get-batch-history.query';

// Entities
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';

// DTOs — IP-3: extracted to dedicated file to keep resolver under 500 lines
import { CreateBatchInput as CreateBatchInputDTO } from '../dto/create-batch.dto';
import {
  UpdateBatchInput,
  RecordMortalityInput,
  RecordCullInput,
  AllocateToTankInput,
  TransferBatchInput,
  BatchFilterInput,
  BatchDocumentResponse,
  BatchListResponse,
  BatchPerformanceResponse,
  BatchHistoryEntryResponse,
  AvailableTankResponse,
} from '../dto/batch-resolver.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BatchDocumentDataLoader } from '../dataloaders/batch-document.dataloader';

// Register enums (only those not already registered in their entity/types files)
// ArrivalMethod → registered in batch.types.ts
// BatchDocumentType → registered in batch-document.entity.ts
registerEnumType(MortalityReason, { name: 'MortalityReason' });
registerEnumType(CullReason, { name: 'CullReason' });
registerEnumType(BatchCloseReason, { name: 'BatchCloseReason' });
registerEnumType(AllocationType, { name: 'AllocationType' });
registerEnumType(BatchHistoryEventType, { name: 'BatchHistoryEventType' });

// IP-3: DTO types moved to ../dto/batch-resolver.dto.ts

// Create a local alias for use in this file
const CreateBatchInput = CreateBatchInputDTO;
type CreateBatchInput = CreateBatchInputDTO;

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => Batch)
export class BatchResolver {
  private readonly logger = new Logger(BatchResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
    private readonly batchDocumentDataLoader: BatchDocumentDataLoader,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Query(() => Batch, { name: 'batch' })
  async getBatch(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Batch> {
    this.logger.debug(`Getting batch: ${id}`);
    return this.queryBus.execute(new GetBatchQuery(tenantId, id));
  }

  @Query(() => BatchListResponse, { name: 'batches' })
  async listBatches(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => BatchFilterInput, nullable: true }) filter?: BatchFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('sortBy', { nullable: true, defaultValue: 'stockedAt' }) sortBy?: string,
    @Args('sortOrder', { nullable: true, defaultValue: 'DESC' }) sortOrder?: 'ASC' | 'DESC',
  ): Promise<BatchListResponse> {
    this.logger.debug(`Listing batches for tenant: ${tenantId}`);
    const result = await this.queryBus.execute<ListBatchesQuery, PaginatedQueryResult<Batch>>(
      new ListBatchesQuery(tenantId, filter, page, limit, sortBy, sortOrder),
    );

    return fromCqrsPaginated(result);
  }

  @Query(() => BatchPerformanceResponse, { name: 'batchPerformance' })
  async getBatchPerformance(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<BatchPerformanceResponse> {
    this.logger.debug(`Getting batch performance: ${id}`);
    return this.queryBus.execute(new GetBatchPerformanceQuery(tenantId, id));
  }

  @Query(() => [BatchHistoryEntryResponse], { name: 'batchHistory' })
  async getBatchHistory(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('eventTypes', { type: () => [BatchHistoryEventType], nullable: true }) eventTypes?: BatchHistoryEventType[],
    @Args('fromDate', { nullable: true }) fromDate?: Date,
    @Args('toDate', { nullable: true }) toDate?: Date,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit?: number,
  ): Promise<BatchHistoryEntryResponse[]> {
    this.logger.debug(`Getting batch history: ${id}`);
    return this.queryBus.execute(
      new GetBatchHistoryQuery(tenantId, id, eventTypes, fromDate, toDate, limit),
    );
  }

  @Query(() => [AvailableTankResponse], { name: 'availableTanks' })
  async listAvailableTanks(
    @Tenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('excludeFullTanks', { nullable: true, defaultValue: false }) excludeFullTanks?: boolean,
  ): Promise<AvailableTankResponse[]> {
    this.logger.debug(`Listing available tanks for tenant: ${tenantId}`);
    return this.queryBus.execute(
      new ListAvailableTanksQuery(tenantId, siteId, departmentId, excludeFullTanks),
    );
  }

  @Query(() => String, { name: 'generateBatchNumber' })
  async generateBatchNumber(
    @Tenant() tenantId: string,
  ): Promise<string> {
    this.logger.debug(`Generating batch number for tenant: ${tenantId}`);
    return this.queryBus.execute(new GenerateBatchNumberQuery(tenantId));
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async createBatch(
    @Args('input') input: CreateBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Creating batch for species: ${input.speciesId}`);

    // Transform DTO to command payload
    const payload: CreateBatchPayload = {
      name: input.name,
      description: input.description,
      speciesId: input.speciesId,
      strain: input.strain,
      inputType: input.inputType,
      initialQuantity: input.initialQuantity,
      initialAvgWeightG: input.initialWeight.avgWeight,
      stockedAt: new Date(input.stockedAt),
      expectedHarvestDate: input.expectedHarvestDate ? new Date(input.expectedHarvestDate) : undefined,
      targetFCR: input.targetFCR,
      supplierId: input.supplierId,
      supplierBatchNumber: input.supplierBatchNumber,
      purchaseCost: input.purchaseCost,
      currency: input.currency,
      arrivalMethod: input.arrivalMethod,
      healthCertificates: input.healthCertificates?.map(doc => ({
        ...doc,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
      })),
      importDocuments: input.importDocuments?.map(doc => ({
        ...doc,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
      })),
      initialLocations: input.initialLocations?.map(loc => ({
        locationType: loc.locationType,
        tankId: loc.tankId,
        pondId: loc.pondId,
        quantity: loc.quantity,
        biomass: loc.biomass,
        allocationDate: loc.allocationDate,
      })),
      notes: input.notes,
    };

    return this.commandBus.execute(
      new CreateBatchCommand(tenantId, payload, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async updateBatch(
    @Args('input') input: UpdateBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Updating batch: ${input.id}`);
    return this.commandBus.execute(
      new UpdateBatchCommand(tenantId, input.id, input, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async updateBatchStatus(
    @Args('id', { type: () => ID }) id: string,
    @Args('status', { type: () => BatchStatus }) status: BatchStatus,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
  ): Promise<Batch> {
    this.logger.log(`Updating batch status: ${id} to ${status}`);
    return this.commandBus.execute(
      new UpdateBatchStatusCommand(tenantId, id, status, user.sub, reason),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async recordMortality(
    @Args('input') input: RecordMortalityInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Recording mortality for batch: ${input.batchId}`);
    const { batchId, ...payload } = input;
    return this.commandBus.execute(
      new RecordMortalityCommand(tenantId, batchId, payload, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async recordCull(
    @Args('input') input: RecordCullInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Recording cull for batch: ${input.batchId}`);
    const { batchId, ...payload } = input;
    return this.commandBus.execute(
      new RecordCullCommand(tenantId, batchId, payload, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async allocateBatchToTank(
    @Args('input') input: AllocateToTankInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Allocating batch ${input.batchId} to tank ${input.tankId}`);
    const { batchId, ...rest } = input;
    const payload = { ...rest, allocatedAt: rest.allocatedAt || new Date() };
    return this.commandBus.execute(
      new AllocateToTankCommand(tenantId, batchId, payload, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async transferBatch(
    @Args('input') input: TransferBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Transferring batch ${input.batchId} from ${input.sourceTankId} to ${input.destinationTankId}`);
    const { batchId, ...rest } = input;
    const payload = { ...rest, transferredAt: rest.transferredAt || new Date() };
    return this.commandBus.execute(
      new TransferBatchCommand(tenantId, batchId, payload, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async closeBatch(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason', { type: () => BatchCloseReason }) reason: BatchCloseReason,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<Batch> {
    this.logger.log(`Closing batch: ${id} with reason: ${reason}`);
    return this.commandBus.execute(
      new CloseBatchCommand(tenantId, id, reason, user.sub, notes),
    );
  }

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  @ResolveField(() => Float, { name: 'currentBiomassKg' })
  getCurrentBiomass(@Parent() batch: Batch): number {
    return batch.getCurrentBiomass();
  }

  @ResolveField(() => Float, { name: 'currentAvgWeightG' })
  getCurrentAvgWeight(@Parent() batch: Batch): number {
    return batch.getCurrentAvgWeight();
  }

  @ResolveField(() => Float, { name: 'mortalityRate' })
  getMortalityRate(@Parent() batch: Batch): number {
    return batch.getMortalityRate();
  }

  @ResolveField(() => Float, { name: 'survivalRate' })
  getSurvivalRate(@Parent() batch: Batch): number {
    return batch.getSurvivalRate();
  }

  @ResolveField(() => Int, { name: 'daysInProduction' })
  getDaysInProduction(@Parent() batch: Batch): number {
    return batch.getDaysInProduction();
  }

  // ── Document field resolvers — DataLoader pattern (eliminates N+1) ─────────
  // Previously 3 × N individual queries per batch in a list. BatchDocumentDataLoader
  // batches all batchIds in a GraphQL execution tick into ONE query, then filters
  // by type in memory. For a page of 20 batches: 1 query instead of 60.

  @ResolveField(() => [BatchDocumentResponse], { name: 'documents' })
  async getDocuments(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    return this.batchDocumentDataLoader.loadAll(batch.id);
  }

  @ResolveField(() => [BatchDocumentResponse], { name: 'healthCertificates' })
  async getHealthCertificates(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    return this.batchDocumentDataLoader.loadByType(batch.id, BatchDocumentType.HEALTH_CERTIFICATE);
  }

  @ResolveField(() => [BatchDocumentResponse], { name: 'importDocuments' })
  async getImportDocuments(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    return this.batchDocumentDataLoader.loadByType(batch.id, BatchDocumentType.IMPORT_DOCUMENT);
  }
}
