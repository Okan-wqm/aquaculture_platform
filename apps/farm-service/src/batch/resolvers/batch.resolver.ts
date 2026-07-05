/**
 * Batch GraphQL Resolver
 *
 * IP-3: DTO types extracted to batch-resolver.dto.ts (560 lines → separate file).
 * This resolver now contains only query/mutation/field-resolver logic (~300 lines).
 *
 * @module Batch/Resolvers
 */
import {
  Tenant,
  CurrentUser,
  Roles,
  Role,
  RequiresMobileFeature,
} from '@aquaculture/backend-common/decorators';
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { UseGuards, Logger } from '@nestjs/common';
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
import { InjectRepository } from '@nestjs/typeorm';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Repository } from 'typeorm';

import { Cacheable } from '../../common/cache/cacheable.decorator';
import { CacheEvict } from '../../common/cache/cache-evict.decorator';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { AllocateToTankCommand } from '../commands/allocate-to-tank.command';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { CreateBatchCommand, CreateBatchPayload } from '../commands/create-batch.command';
import { RecordCullCommand, CullReason } from '../commands/record-cull.command';
import { RecordMortalityCommand, MortalityReason } from '../commands/record-mortality.command';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { RecordGradingCommand } from '../commands/record-grading.command';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { UpdateBatchCommand } from '../commands/update-batch.command';
import { BatchDocumentDataLoader } from '../dataloaders/batch-document.dataloader';
import { BatchFeedAssignmentDataLoader } from '../dataloaders/batch-feed-assignment.dataloader';
import { BatchLocationDataLoader } from '../dataloaders/batch-location.dataloader';
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
  RecordGradingInput,
} from '../dto/batch-resolver.dto';
import { CreateBatchInput as CreateBatchInputDTO } from '../dto/create-batch.dto';
import {
  TankCountReconcileService,
  TankCountReconcileRow,
} from '../services/tank-count-reconcile.service';
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';
import { BatchFeedAssignment } from '../entities/batch-feed-assignment.entity';
import { BatchLocation } from '../entities/batch-location.entity';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { GenerateBatchNumberQuery } from '../queries/generate-batch-number.query';
import { GetBatchHistoryQuery, BatchHistoryEventType } from '../queries/get-batch-history.query';
import { GetBatchTraceabilityQuery } from '../queries/get-batch-traceability.query';
import { BatchTraceabilityResponse } from '../dto/batch-traceability.response';
import { GetBatchPerformanceQuery } from '../queries/get-batch-performance.query';
import { GetBatchQuery } from '../queries/get-batch.query';
import { ListAvailableTanksQuery } from '../queries/list-available-tanks.query';
import { ListBatchesQuery } from '../queries/list-batches.query';

/**
 * User context interface for CurrentUser decorator
 */
/**
 * WHY: roles typed as Role[] because JWT guard validates enum membership
 * before the request reaches the resolver layer. This makes the type
 * boundary explicit at the point closest to the untrusted input.
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: Role[];
  // SEC-HIGH-051: the caller's assigned farm Site ids (object-level site authz).
  assignedSiteIds?: string[];
  // SEC-HIGH-052: the caller's enabled mobile feature keys (read by the guard).
  mobileFeatures?: string[];
}

// Register enums (only those not already registered in their entity/types files)
// ArrivalMethod → registered in batch.types.ts
// BatchDocumentType → registered in batch-document.entity.ts
// Register command-specific enums (not registered in their definition files)
// AllocationType → registered in tank-allocation.entity.ts (single source of truth)
registerEnumType(MortalityReason, { name: 'MortalityReason' });
registerEnumType(CullReason, { name: 'CullReason' });
registerEnumType(BatchCloseReason, { name: 'BatchCloseReason' });
registerEnumType(BatchHistoryEventType, { name: 'BatchHistoryEventType' });

// IP-3: DTO types moved to ../dto/batch-resolver.dto.ts

// Create a local alias for use in this file
const CreateBatchInput = CreateBatchInputDTO;
type CreateBatchInput = CreateBatchInputDTO;

// ============================================================================
// RESOLVER
// ============================================================================

// SEC-HIGH-052: MobileFeatureGuard runs alongside the JWT guard; it is a no-op
// on routes without @RequiresMobileFeature and enforces the mobile entitlement
// (auth.mobile_user_settings.allowedFeatures) on the annotated mutations below.
@UseGuards(GqlAuthGuard, MobileFeatureGuard)
@Resolver(() => Batch)
export class BatchResolver {
  private readonly logger = new Logger(BatchResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
    private readonly batchDocumentDataLoader: BatchDocumentDataLoader,
    private readonly batchLocationDataLoader: BatchLocationDataLoader,
    private readonly batchFeedAssignmentDataLoader: BatchFeedAssignmentDataLoader,
    private readonly tankCountReconcile: TankCountReconcileService,
  ) {}

  // -------------------------------------------------------------------------
  // MAINTENANCE
  // -------------------------------------------------------------------------

  /**
   * One-time reconciliation of the tank fish-COUNT drift (FARM-HIGH-106): recompute
   * each tank-batch's true count from the operation ledger and, when dryRun=false,
   * correct it through the single writer (applyBatchDelta) so tank_batches +
   * currentCount land on the ledger truth and web == mobile. dryRun (default true)
   * returns the diff WITHOUT writing so the operator reviews it first. TENANT_ADMIN
   * only — it corrects persisted counts.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => [TankCountReconcileRow], {
    description:
      'Reconcile tank fish-count drift from the operation ledger. dryRun (default ' +
      'true) reports the per-tank-batch diff without writing; dryRun=false applies ' +
      'the correction through the single writer. TENANT_ADMIN only.',
  })
  async reconcileTankCounts(
    @Tenant() tenantId: string,
    @Args('dryRun', { type: () => Boolean, nullable: true, defaultValue: true })
    dryRun: boolean,
    @Args('tankIds', { type: () => [ID], nullable: true })
    tankIds?: string[] | null,
  ): Promise<TankCountReconcileRow[]> {
    return this.tankCountReconcile.reconcile(tenantId, {
      dryRun,
      tankIds: tankIds ?? undefined,
    });
  }

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Batch, { name: 'batch' })
  async getBatch(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Batch> {
    this.logger.debug(`Getting batch: ${id}`);
    return this.queryBus.execute(new GetBatchQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
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

  /**
   * Phase 7.3.1 — cache batch performance for 1 hour. The calculator
   * fan-outs across batch + health_events + work_orders and used to
   * do its own Redis caching inside the query handler. The cache
   * logic now lives at the resolver boundary (one pattern for the
   * whole service) and the handler body is pure compute.
   */
  @Cacheable({ prefix: 'batch:performance', ttlSeconds: 3600 })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => BatchPerformanceResponse, { name: 'batchPerformance' })
  async getBatchPerformance(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<BatchPerformanceResponse> {
    this.logger.debug(`Getting batch performance: ${id}`);
    return this.queryBus.execute(new GetBatchPerformanceQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [BatchHistoryEntryResponse], { name: 'batchHistory' })
  async getBatchHistory(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('eventTypes', { type: () => [BatchHistoryEventType], nullable: true })
    eventTypes?: BatchHistoryEventType[],
    @Args('fromDate', { nullable: true }) fromDate?: Date,
    @Args('toDate', { nullable: true }) toDate?: Date,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit?: number,
  ): Promise<BatchHistoryEntryResponse[]> {
    this.logger.debug(`Getting batch history: ${id}`);
    return this.queryBus.execute(
      new GetBatchHistoryQuery(tenantId, id, eventTypes, fromDate, toDate, limit),
    );
  }

  /**
   * Full lifecycle traceability report for one batch (Phase 6): residency
   * intervals + operation timeline + per-feed consumption + water temperature
   * per residency. Read-only composition over the existing SSoTs.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => BatchTraceabilityResponse, { name: 'batchTraceability' })
  async getBatchTraceability(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<BatchTraceabilityResponse> {
    this.logger.debug(`Getting batch traceability report: ${id}`);
    return this.queryBus.execute(new GetBatchTraceabilityQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
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

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => String, { name: 'generateBatchNumber' })
  async generateBatchNumber(@Tenant() tenantId: string): Promise<string> {
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
      protocolId: input.protocolId,
      inputType: input.inputType,
      initialQuantity: input.initialQuantity,
      initialAvgWeightG: input.initialWeight.avgWeight,
      stockedAt: new Date(input.stockedAt),
      expectedHarvestDate: input.expectedHarvestDate
        ? new Date(input.expectedHarvestDate)
        : undefined,
      targetFCR: input.targetFCR,
      supplierId: input.supplierId,
      supplierBatchNumber: input.supplierBatchNumber,
      purchaseCost: input.purchaseCost,
      currency: input.currency,
      arrivalMethod: input.arrivalMethod,
      healthCertificates: input.healthCertificates?.map((doc) => ({
        ...doc,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
      })),
      importDocuments: input.importDocuments?.map((doc) => ({
        ...doc,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
      })),
      initialLocations: input.initialLocations?.map((loc) => ({
        locationType: loc.locationType,
        tankId: loc.tankId,
        pondId: loc.pondId,
        quantity: loc.quantity,
        biomass: loc.biomass,
        allocationDate: loc.allocationDate,
      })),
      notes: input.notes,
    };

    return this.commandBus.execute(new CreateBatchCommand(tenantId, payload, user.sub));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => Batch)
  async updateBatch(
    @Args('input') input: UpdateBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Updating batch: ${input.id}`);
    return this.commandBus.execute(new UpdateBatchCommand(tenantId, input.id, input, user.sub));
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

  // SSOT-H-18: mortality changes survival + biomass that batchPerformance reports;
  // evict its 1h cache (otherwise never invalidated) so FCR/survival aren't stale.
  @CacheEvict({ prefixes: ['batch:performance'] })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('mortality')
  @Mutation(() => Batch)
  async recordMortality(
    @Args('input') input: RecordMortalityInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Recording mortality for batch: ${input.batchId}`);
    const {
      batchId,
      clientCommandId: _clientCommandId,
      clientCreatedAt: _clientCreatedAt,
      deviceId: _deviceId,
      operationType: _operationType,
      payloadHash: _payloadHash,
      schemaVersion: _schemaVersion,
      ...payload
    } = input;
    return this.commandBus.execute(
      new RecordMortalityCommand(
        tenantId,
        batchId,
        payload,
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  // SSOT-H-18: cull changes survival + biomass that batchPerformance reports; evict.
  @CacheEvict({ prefixes: ['batch:performance'] })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('cull')
  @Mutation(() => Batch)
  async recordCull(
    @Args('input') input: RecordCullInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Recording cull for batch: ${input.batchId}`);
    const {
      batchId,
      clientCommandId: _clientCommandId,
      clientCreatedAt: _clientCreatedAt,
      deviceId: _deviceId,
      operationType: _operationType,
      payloadHash: _payloadHash,
      schemaVersion: _schemaVersion,
      ...payload
    } = input;
    return this.commandBus.execute(
      new RecordCullCommand(
        tenantId,
        batchId,
        payload,
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  // SEC-HIGH-052: placing fish into a tank is a transfer-class field operation,
  // gated by the same 'transfer' mobile entitlement as transferBatch (its
  // sibling). Site authz is already enforced at the AllocateToTankHandler sink.
  @RequiresMobileFeature('transfer')
  @Mutation(() => Batch)
  async allocateBatchToTank(
    @Args('input') input: AllocateToTankInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(`Allocating batch ${input.batchId} to tank ${input.tankId}`);
    const {
      batchId,
      clientCommandId: _clientCommandId,
      clientCreatedAt: _clientCreatedAt,
      deviceId: _deviceId,
      operationType: _operationType,
      payloadHash: _payloadHash,
      schemaVersion: _schemaVersion,
      ...rest
    } = input;
    const payload = { ...rest, allocatedAt: rest.allocatedAt || new Date() };
    return this.commandBus.execute(
      new AllocateToTankCommand(
        tenantId,
        batchId,
        payload,
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('transfer')
  @Mutation(() => Batch)
  async transferBatch(
    @Args('input') input: TransferBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(
      `Transferring batch ${input.batchId} from ${input.sourceTankId} to ${input.destinationTankId}`,
    );
    const {
      batchId,
      clientCommandId: _clientCommandId,
      clientCreatedAt: _clientCreatedAt,
      deviceId: _deviceId,
      operationType: _operationType,
      payloadHash: _payloadHash,
      schemaVersion: _schemaVersion,
      ...rest
    } = input;
    const payload = { ...rest, transferredAt: rest.transferredAt || new Date() };
    return this.commandBus.execute(
      new TransferBatchCommand(
        tenantId,
        batchId,
        payload,
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  // FARM-MEDIUM-117: grading is a transfer-class field operation; each output
  // movement carries its own idempotency envelope and runs through the
  // TransferBatchCommand SSoT with reason 'grading'.
  @RequiresMobileFeature('transfer')
  @Mutation(() => Batch)
  async recordGrading(
    @Args('input') input: RecordGradingInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Batch> {
    this.logger.log(
      `Grading batch ${input.batchId} from tank ${input.sourceTankId} into ${input.outputs.length} outputs`,
    );
    return this.commandBus.execute(
      new RecordGradingCommand(
        tenantId,
        input.batchId,
        {
          sourceTankId: input.sourceTankId,
          gradedAt: input.gradedAt,
          notes: input.notes,
          outputs: input.outputs.map((o) => ({
            destinationTankId: o.destinationTankId,
            quantity: o.quantity,
            avgWeightG: o.avgWeightG,
            sizeClass: o.sizeClass,
            clientCommandId: o.clientCommandId,
            payloadHash: o.payloadHash,
          })),
          deviceId: input.deviceId,
          clientCreatedAt: input.clientCreatedAt,
          schemaVersion: input.schemaVersion,
        },
        user.sub,
        user.roles,
        user.assignedSiteIds ?? [],
      ),
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
    @Args('acknowledgeActiveTreatments', {
      nullable: true,
      defaultValue: false,
      description:
        'Explicit override for closing a batch that still has an open ' +
        'medicine withdrawal period. Defaults to false — the close will ' +
        'be rejected with the list of blocking events if the flag is not ' +
        'set. When true, the override is written to the audit log.',
    })
    acknowledgeActiveTreatments?: boolean,
  ): Promise<Batch> {
    this.logger.log(`Closing batch: ${id} with reason: ${reason}`);
    // WHY: Using typed options object prevents argument transposition.
    // Previously, user.sub was stored as notes and notes as closedBy.
    return this.commandBus.execute(
      new CloseBatchCommand({
        tenantId,
        batchId: id,
        reason,
        closedBy: user.sub,
        userRoles: user.roles,
        notes,
        acknowledgeActiveTreatments: acknowledgeActiveTreatments ?? false,
      }),
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

  // ── FARM-MEDIUM-005: DataLoader field resolvers (eliminates N+1) ───────────
  // All relational field resolvers use DataLoaders to batch queries across a
  // GraphQL execution tick. For a page of 20 batches: 1 query per relation
  // instead of 20.

  @ResolveField(() => [BatchLocation], { name: 'locations' })
  async getLocations(@Parent() batch: Batch): Promise<BatchLocation[]> {
    return this.batchLocationDataLoader.load(batch.id);
  }

  @ResolveField(() => [BatchFeedAssignment], { name: 'feedAssignments' })
  async getFeedAssignments(@Parent() batch: Batch): Promise<BatchFeedAssignment[]> {
    return this.batchFeedAssignmentDataLoader.load(batch.id);
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
