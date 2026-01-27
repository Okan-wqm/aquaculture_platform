/**
 * Batch GraphQL Resolver
 *
 * Batch CRUD operasyonları ve performans sorguları için GraphQL API.
 *
 * @module Batch/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
  InputType,
  ResolveField,
  Parent,
  registerEnumType,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { UseGuards, Logger } from '@nestjs/common';
import { IsUUID, IsNotEmpty, IsInt, Min, IsOptional, IsNumber, IsString, IsDate, IsEnum } from 'class-validator';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Tenant, CurrentUser, Roles, Role } from '@platform/backend-common';
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

// DTOs
import {
  CreateBatchInput as CreateBatchInputDTO,
  BatchDocumentInput,
  InitialLocationInput,
  InitialWeightInput,
} from '../dto/create-batch.dto';
import { ArrivalMethod } from '../entities/batch.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Register enums
registerEnumType(MortalityReason, { name: 'MortalityReason' });
registerEnumType(CullReason, { name: 'CullReason' });
registerEnumType(BatchCloseReason, { name: 'BatchCloseReason' });
registerEnumType(AllocationType, { name: 'AllocationType' });
registerEnumType(BatchHistoryEventType, { name: 'BatchHistoryEventType' });
registerEnumType(ArrivalMethod, { name: 'ArrivalMethod' });
registerEnumType(BatchDocumentType, { name: 'BatchDocumentType' });

// ============================================================================
// INPUT TYPES
// ============================================================================

/**
 * GraphQL ObjectType for BatchDocument response
 */
@ObjectType()
export class BatchDocumentResponse {
  @Field(() => ID)
  id: string;

  @Field(() => BatchDocumentType)
  documentType: BatchDocumentType;

  @Field()
  documentName: string;

  @Field({ nullable: true })
  documentNumber?: string;

  @Field()
  storagePath: string;

  @Field()
  storageUrl: string;

  @Field()
  originalFilename: string;

  @Field()
  mimeType: string;

  @Field(() => Int)
  fileSize: number;

  @Field({ nullable: true })
  issueDate?: Date;

  @Field({ nullable: true })
  expiryDate?: Date;

  @Field({ nullable: true })
  issuingAuthority?: string;

  @Field({ nullable: true })
  notes?: string;

  @Field()
  createdAt: Date;
}

/**
 * Use the DTO-defined CreateBatchInput with full validation
 * Re-export for GraphQL schema
 */
export { BatchDocumentInput, InitialLocationInput, InitialWeightInput };

// Create a local alias for use in this file
const CreateBatchInput = CreateBatchInputDTO;
type CreateBatchInput = CreateBatchInputDTO;
export { CreateBatchInput };

@InputType()
export class UpdateBatchInput implements UpdateBatchPayload {
  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  expectedHarvestDate?: Date;

  @Field(() => Float, { nullable: true })
  targetFCR?: number;

  @Field({ nullable: true })
  notes?: string;
}

@InputType()
export class RecordMortalityInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => MortalityReason)
  @IsNotEmpty()
  @IsEnum(MortalityReason)
  reason: MortalityReason;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  detail?: string;

  @Field({ defaultValue: () => new Date() })
  @IsOptional()
  observedAt: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  observedBy?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  avgWeightG?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class RecordCullInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => CullReason)
  @IsNotEmpty()
  @IsEnum(CullReason)
  reason: CullReason;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  detail?: string;

  @Field({ defaultValue: () => new Date() })
  @IsOptional()
  culledAt: Date;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  avgWeightG?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class AllocateToTankInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  tankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  avgWeightG: number;

  @Field(() => AllocationType, { defaultValue: AllocationType.INITIAL_STOCKING })
  @IsOptional()
  @IsEnum(AllocationType)
  allocationType: AllocationType;

  @Field({ nullable: true })
  @IsOptional()
  allocatedAt?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class TransferBatchInput {
  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  batchId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  sourceTankId: string;

  @Field(() => ID)
  @IsNotEmpty()
  @IsUUID()
  destinationTankId: string;

  @Field(() => Int)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  avgWeightG?: number;

  @Field({ nullable: true })
  @IsOptional()
  transferredAt?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  transferReason?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field(() => Boolean, { nullable: true, defaultValue: false, description: 'Kapasite kontrolünü atla (aşırı yüklemeye izin ver)' })
  @IsOptional()
  skipCapacityCheck?: boolean;
}

@InputType()
export class BatchFilterInput implements BatchFilter {
  @Field(() => [BatchStatus], { nullable: true })
  status?: BatchStatus[];

  @Field(() => ID, { nullable: true })
  speciesId?: string;

  @Field(() => BatchInputType, { nullable: true })
  inputType?: BatchInputType;

  @Field(() => ID, { nullable: true })
  supplierId?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  isActive?: boolean;

  @Field({ nullable: true })
  stockedAfter?: Date;

  @Field({ nullable: true })
  stockedBefore?: Date;

  @Field({ nullable: true })
  searchTerm?: string;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export enum FCRStatusType {
  EXCELLENT = 'excellent',
  GOOD = 'good',
  AVERAGE = 'average',
  POOR = 'poor',
}

export enum PerformanceStatusType {
  EXCELLENT = 'excellent',
  GOOD = 'good',
  AVERAGE = 'average',
  BELOW_AVERAGE = 'below_average',
  POOR = 'poor',
}

registerEnumType(FCRStatusType, { name: 'FCRStatusType' });
registerEnumType(PerformanceStatusType, { name: 'PerformanceStatusType' });

@ObjectType()
export class FCRInfo {
  @Field(() => Float)
  target: number;

  @Field(() => Float)
  actual: number;

  @Field(() => Float)
  theoretical: number;

  @Field(() => Float)
  variance: number;

  @Field(() => FCRStatusType)
  status: 'excellent' | 'good' | 'average' | 'poor';
}

@ObjectType()
export class BatchListResponse {
  @Field(() => [Batch])
  items: Batch[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  totalPages: number;

  @Field()
  hasNextPage: boolean;

  @Field()
  hasPreviousPage: boolean;
}

@ObjectType()
export class BatchPerformanceResponse {
  @Field(() => ID)
  batchId: string;

  @Field()
  batchNumber: string;

  @Field()
  speciesName: string;

  @Field(() => Int)
  initialQuantity: number;

  @Field(() => Int)
  currentQuantity: number;

  @Field(() => Float)
  initialBiomassKg: number;

  @Field(() => Float)
  currentBiomassKg: number;

  @Field(() => Float)
  initialAvgWeightG: number;

  @Field(() => Float)
  currentAvgWeightG: number;

  @Field(() => Float)
  weightGainG: number;

  @Field(() => Float)
  weightGainPercent: number;

  @Field(() => Int)
  totalMortality: number;

  @Field(() => Float)
  mortalityRate: number;

  @Field(() => Float)
  survivalRate: number;

  @Field(() => Float)
  retentionRate: number;

  @Field(() => Int)
  cullCount: number;

  @Field(() => FCRInfo)
  fcr: FCRInfo;

  @Field(() => Float)
  sgr: number;

  @Field(() => Int)
  daysInProduction: number;

  @Field(() => Float)
  avgDailyGrowthG: number;

  @Field(() => Float)
  targetDailyGrowthG: number;

  @Field(() => Float)
  growthVariancePercent: number;

  @Field(() => Float)
  totalFeedConsumedKg: number;

  @Field(() => Float)
  totalFeedCost: number;

  @Field(() => Float)
  avgDailyFeedKg: number;

  @Field(() => Float)
  purchaseCost: number;

  @Field(() => Float)
  totalCost: number;

  @Field(() => Float)
  costPerKg: number;

  @Field(() => Float)
  costPerFish: number;

  @Field({ nullable: true })
  projectedHarvestDate?: Date;

  @Field(() => Float, { nullable: true })
  projectedHarvestWeightG?: number;

  @Field(() => Int, { nullable: true })
  daysToHarvest?: number;

  @Field(() => Int)
  performanceIndex: number;

  @Field(() => PerformanceStatusType)
  performanceStatus: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

@ObjectType()
export class BatchHistoryEntryResponse implements BatchHistoryEntry {
  @Field(() => ID)
  id: string;

  @Field(() => BatchHistoryEventType)
  eventType: BatchHistoryEventType;

  @Field()
  timestamp: Date;

  @Field()
  description: string;

  @Field(() => GraphQLJSON)
  details: Record<string, unknown>;

  @Field({ nullable: true })
  performedBy?: string;

  @Field(() => ID, { nullable: true })
  tankId?: string;

  @Field({ nullable: true })
  tankCode?: string;

  @Field(() => Int, { nullable: true })
  quantityChange?: number;

  @Field(() => Float, { nullable: true })
  biomassChangeKg?: number;
}

@ObjectType()
export class DeleteBatchResponse {
  @Field()
  success: boolean;

  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  message?: string;
}

@ObjectType()
export class AvailableTankResponse implements AvailableTank {
  @Field(() => ID)
  id: string;

  @Field()
  code: string;

  @Field()
  name: string;

  @Field(() => Float)
  volume: number;

  @Field(() => Float)
  maxBiomass: number;

  @Field(() => Float)
  currentBiomass: number;

  @Field(() => Float)
  availableCapacity: number;

  @Field(() => Int)
  currentCount: number;

  @Field(() => Float)
  maxDensity: number;

  @Field(() => Float)
  currentDensity: number;

  @Field()
  status: string;

  @Field(() => ID)
  departmentId: string;

  @Field()
  departmentName: string;

  @Field(() => ID, { nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  siteName?: string;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => Batch)
export class BatchResolver {
  private readonly logger = new Logger(BatchResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
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

    // Transform PaginatedQueryResult to BatchListResponse format
    return {
      items: result.data || [],
      total: result.pagination?.total ?? 0,
      page: result.pagination?.page ?? page ?? 1,
      limit: result.pagination?.limit ?? limit ?? 20,
      totalPages: result.pagination?.totalPages ?? 0,
      hasNextPage: result.pagination?.hasNextPage ?? false,
      hasPreviousPage: result.pagination?.hasPreviousPage ?? false,
    };
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

  @ResolveField(() => [BatchDocumentResponse], { name: 'documents' })
  async getDocuments(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    const documents = await this.documentRepository.find({
      where: { batchId: batch.id, isActive: true },
      order: { createdAt: 'DESC' },
    });
    return documents;
  }

  @ResolveField(() => [BatchDocumentResponse], { name: 'healthCertificates' })
  async getHealthCertificates(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    const documents = await this.documentRepository.find({
      where: {
        batchId: batch.id,
        documentType: BatchDocumentType.HEALTH_CERTIFICATE,
        isActive: true,
      },
      order: { createdAt: 'DESC' },
    });
    return documents;
  }

  @ResolveField(() => [BatchDocumentResponse], { name: 'importDocuments' })
  async getImportDocuments(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
    const documents = await this.documentRepository.find({
      where: {
        batchId: batch.id,
        documentType: BatchDocumentType.IMPORT_DOCUMENT,
        isActive: true,
      },
      order: { createdAt: 'DESC' },
    });
    return documents;
  }
}
