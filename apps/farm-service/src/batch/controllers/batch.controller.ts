/**
 * Batch Controller
 *
 * Deprecated REST compatibility endpoints for batch management.
 * All state changes are routed through CQRS handlers; verified gateway
 * assertions are the only tenant/actor authority.
 *
 * @module Batch
 */
import type { Role } from '@aquaculture/backend-common/decorators';
import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, PaginatedQueryResult, QueryBus } from '@platform/cqrs';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateHarvestRecordCommand } from '../../harvest/commands/create-harvest-record.command';
import { QualityClass } from '../../harvest/entities/harvest-record.entity';
import {
  AllocateToTankCommand,
  AllocationType,
  CreateBatchCommand,
  CullReason,
  DeleteBatchCommand,
  MortalityReason,
  RecordCullCommand,
  RecordMortalityCommand,
  TransferBatchCommand,
  UpdateBatchCommand,
  UpdateBatchStatusCommand,
} from '../commands';
import { BatchInputType, BatchStatus } from '../entities/batch.entity';
import { isCullReason, isMortalityReason } from '../entities/tank-operation.enums';
import { GetBatchPerformanceQuery, GetBatchQuery, ListBatchesQuery } from '../queries';
import { BatchService } from '../services/batch.service';

/**
 * Interface for batch list filters
 */
interface BatchListFilters {
  status?: BatchStatus[];
  speciesId?: string;
  isActive?: boolean;
}

interface VerifiedBatchContext {
  tenantId: string;
  actorUserId: string;
  roles: Role[];
  // SEC-HIGH-051: the caller's assigned Site ids for the object-level site check
  // on the REST stock-mutating paths (same data as the GraphQL resolver path).
  assignedSiteIds: string[];
}

// ============================================================================
// DTOs
// ============================================================================

class CreateBatchDto {
  batchNumber!: string;
  speciesId!: string;
  inputType!: string;
  initialQuantity!: number;
  initialAvgWeightG!: number;
  stockedAt!: string;
  supplierId?: string;
  purchaseCost?: number;
  currency?: string;
  notes?: string;
}

class UpdateBatchDto {
  name?: string;
  description?: string;
  status?: BatchStatus;
  expectedHarvestDate?: string;
  notes?: string;
}

class AllocateBatchDto {
  tankId!: string;
  quantity!: number;
  avgWeightG!: number;
  allocationType!: AllocationType;
  notes?: string;
}

// FARM-HIGH-052: the REST front for stock-mutating operations must also supply
// the idempotency envelope, otherwise the command reaches the handler in
// 'legacy' mode and the handler's mandatory-key reject would 500 every REST
// mortality/cull/transfer. clientCommandId + payloadHash are required here so
// the REST path furnishes the key in the SAME change as the handler reject.
class RecordMortalityDto {
  clientCommandId!: string;
  payloadHash!: string;
  tankId!: string;
  batchId!: string;
  operationDate!: string;
  quantity?: number;
  biomassKg?: number;
  avgWeightG?: number;
  reason?: string;
  detail?: string;
  notes?: string;
}

class RecordCullDto {
  clientCommandId!: string;
  payloadHash!: string;
  tankId!: string;
  batchId!: string;
  operationDate!: string;
  quantity?: number;
  biomassKg?: number;
  avgWeightG?: number;
  reason?: string;
  detail?: string;
  notes?: string;
}

class RecordTransferDto {
  clientCommandId!: string;
  payloadHash!: string;
  tankId!: string;
  batchId!: string;
  destinationTankId!: string;
  operationDate!: string;
  quantity?: number;
  biomassKg?: number;
  avgWeightG?: number;
  reason?: string;
  notes?: string;
}

class RecordHarvestDto {
  tankId!: string;
  batchId!: string;
  operationDate!: string;
  quantity!: number;
  avgWeightG?: number;
  totalWeightKg?: number;
  pricePerKg?: number;
  buyer?: string;
  notes?: string;
}

class BatchListQueryDto {
  status?: string;
  speciesId?: string;
  isActive?: string;
}

function verifiedContext(req: TenantRequest): VerifiedBatchContext {
  const tenantId =
    req.verifiedUserAssertion?.effectiveTenantId ?? req.user?.tenantId ?? req.tenantId;
  const actorUserId = req.verifiedUserAssertion?.subject ?? req.user?.sub;

  if (!tenantId || !actorUserId) {
    throw new BadRequestException('Verified tenant context is required');
  }

  return {
    tenantId,
    actorUserId,
    roles: (req.verifiedUserAssertion?.roles ?? req.user?.roles ?? []) as Role[],
    // SEC-HIGH-051: prefer the HMAC-bound assertion's site claim; fall back to
    // the direct-JWT req.user on the non-gateway path. Default [] is fail-closed.
    assignedSiteIds: req.verifiedUserAssertion?.assignedSiteIds ?? req.user?.assignedSiteIds ?? [],
  };
}

function parseMortalityReason(value: string | undefined): MortalityReason {
  return isMortalityReason(value) ? value : MortalityReason.OTHER;
}

function parseCullReason(value: string | undefined): CullReason {
  return isCullReason(value) ? value : CullReason.OTHER;
}

/**
 * FARM-HIGH-052: build the idempotency envelope from a REST DTO so the
 * stock-mutating command reaches the handler with a clientCommandId +
 * payloadHash (non-legacy mode). The REST caller supplies both fields.
 */
function restMobileEnvelope(
  dto: { clientCommandId: string; payloadHash: string },
  operationType: string,
): MobileCommandEnvelope {
  return {
    clientCommandId: dto.clientCommandId,
    payloadHash: dto.payloadHash,
    operationType,
  };
}

// ============================================================================
// CONTROLLER
// ============================================================================

@UseGuards(JwtAuthGuard)
@Controller('batches')
export class BatchController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly batchService: BatchService,
  ) {}

  // -------------------------------------------------------------------------
  // BATCH CRUD
  // -------------------------------------------------------------------------

  /**
   * POST /api/batches - Yeni batch oluştur
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBatch(@Req() req: TenantRequest, @Body() dto: CreateBatchDto) {
    const { tenantId, actorUserId } = verifiedContext(req);

    const batch = await this.commandBus.execute(
      new CreateBatchCommand(
        tenantId,
        {
          batchNumber: dto.batchNumber,
          speciesId: dto.speciesId,
          inputType: dto.inputType as BatchInputType,
          initialQuantity: dto.initialQuantity,
          initialAvgWeightG: dto.initialAvgWeightG,
          stockedAt: new Date(dto.stockedAt),
          supplierId: dto.supplierId,
          purchaseCost: dto.purchaseCost,
          currency: dto.currency,
          notes: dto.notes,
        },
        actorUserId,
      ),
    );

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * GET /api/batches - Batch listesi
   */
  @Get()
  async listBatches(@Req() req: TenantRequest, @Query() query: BatchListQueryDto) {
    const { tenantId } = verifiedContext(req);
    const filters: BatchListFilters = {};

    if (query.status) {
      filters.status = query.status.split(',') as BatchStatus[];
    }

    if (query.speciesId) {
      filters.speciesId = query.speciesId;
    }

    if (query.isActive !== undefined) {
      filters.isActive = query.isActive === 'true';
    }

    const batches = await this.queryBus.execute<ListBatchesQuery, PaginatedQueryResult<unknown>>(
      new ListBatchesQuery(tenantId, filters),
    );

    return {
      success: true,
      data: batches.data,
      total: batches.pagination.total,
      pagination: batches.pagination,
    };
  }

  /**
   * GET /api/batches/:id - Batch detay
   */
  @Get(':id')
  async getBatch(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { tenantId } = verifiedContext(req);
    const batch = await this.queryBus.execute(new GetBatchQuery(tenantId, id));

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * PUT /api/batches/:id - Batch güncelle
   */
  @Put(':id')
  async updateBatch(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBatchDto,
  ) {
    const { tenantId, actorUserId } = verifiedContext(req);

    const batch = await this.commandBus.execute(
      new UpdateBatchCommand(
        tenantId,
        id,
        {
          name: dto.name,
          description: dto.description,
          notes: dto.notes,
          expectedHarvestDate: dto.expectedHarvestDate
            ? new Date(dto.expectedHarvestDate)
            : undefined,
        },
        actorUserId,
      ),
    );

    if (dto.status) {
      await this.commandBus.execute(
        new UpdateBatchStatusCommand(tenantId, id, dto.status, undefined, actorUserId),
      );
    }

    return {
      success: true,
      data: dto.status ? await this.queryBus.execute(new GetBatchQuery(tenantId, id)) : batch,
    };
  }

  /**
   * DELETE /api/batches/:id - Batch sil (soft delete)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBatch(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { tenantId, actorUserId } = verifiedContext(req);
    await this.commandBus.execute(new DeleteBatchCommand({ tenantId, batchId: id, actorUserId }));
  }

  // -------------------------------------------------------------------------
  // TANK ALLOCATION
  // -------------------------------------------------------------------------

  /**
   * POST /api/batches/:id/allocate - Batch'i tank'a dağıt
   */
  @Post(':id/allocate')
  @HttpCode(HttpStatus.CREATED)
  async allocateBatch(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
    @Body() dto: AllocateBatchDto,
  ) {
    // SEC-HIGH-051: thread roles AND assignedSiteIds from the authenticated REST
    // principal. AllocateToTankCommand's positional params are
    // (tenantId, batchId, payload, allocatedBy, userRoles, callerAssignedSiteIds).
    // Omitting assignedSiteIds previously left it at its `[]` default, which
    // fail-closed denies a legitimate same-site MODULE_USER at the handler's
    // assertSiteAssignment. Pass it from the same verified context the GraphQL
    // path uses (assertion site claim, JWT fallback).
    const { tenantId, actorUserId, roles, assignedSiteIds } = verifiedContext(req);

    const allocation = await this.commandBus.execute(
      new AllocateToTankCommand(
        tenantId,
        batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          allocationType: dto.allocationType,
          notes: dto.notes,
        },
        actorUserId,
        roles,
        assignedSiteIds,
      ),
    );

    return {
      success: true,
      data: allocation,
    };
  }

  /**
   * GET /api/batches/:id/allocations - Batch'in tank dağılımları
   */
  @Get(':id/allocations')
  async getBatchAllocations(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
    const { tenantId } = verifiedContext(req);
    const allocations = await this.batchService.getBatchAllocations(batchId, tenantId);

    return {
      success: true,
      data: allocations,
    };
  }

  /**
   * GET /api/batches/:id/operations - Batch'in operasyon geçmişi
   */
  @Get(':id/operations')
  async getBatchOperations(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) batchId: string) {
    const { tenantId } = verifiedContext(req);
    const operations = await this.batchService.getBatchOperations(batchId, tenantId);

    return {
      success: true,
      data: operations,
    };
  }

  /**
   * GET /api/batches/:id/metrics - Batch metrikleri
   */
  @Get(':id/metrics')
  async getBatchMetrics(@Req() req: TenantRequest, @Param('id', ParseUUIDPipe) batchId: string) {
    const { tenantId } = verifiedContext(req);
    const metrics = await this.queryBus.execute(new GetBatchPerformanceQuery(tenantId, batchId));

    return {
      success: true,
      data: metrics,
    };
  }
}

// ============================================================================
// TANK OPERATIONS CONTROLLER
// ============================================================================

@UseGuards(JwtAuthGuard)
@Controller('tank-operations')
export class TankOperationsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly batchService: BatchService,
  ) {}

  /**
   * POST /api/tank-operations/mortality - Ölüm kaydı
   */
  @Post('mortality')
  @HttpCode(HttpStatus.CREATED)
  async recordMortality(
    @Req() req: TenantRequest,
    @Body() dto: RecordMortalityDto,
  ): Promise<{ success: boolean; data: unknown }> {
    const { tenantId, actorUserId, roles, assignedSiteIds } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new RecordMortalityCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          biomassKg: dto.biomassKg,
          avgWeightG: dto.avgWeightG,
          reason: parseMortalityReason(dto.reason),
          detail: dto.detail,
          observedAt: new Date(dto.operationDate),
          observedBy: actorUserId,
          notes: dto.notes,
        },
        actorUserId,
        roles,
        assignedSiteIds,
        restMobileEnvelope(dto, 'recordMortality'),
      ),
    );

    return {
      success: true,
      data: operation,
    };
  }

  /**
   * POST /api/tank-operations/cull - Ayıklama kaydı
   */
  @Post('cull')
  @HttpCode(HttpStatus.CREATED)
  async recordCull(@Req() req: TenantRequest, @Body() dto: RecordCullDto) {
    const { tenantId, actorUserId, roles, assignedSiteIds } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new RecordCullCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          biomassKg: dto.biomassKg,
          avgWeightG: dto.avgWeightG,
          reason: parseCullReason(dto.reason),
          detail: dto.detail,
          culledAt: new Date(dto.operationDate),
          notes: dto.notes,
        },
        actorUserId,
        roles,
        assignedSiteIds,
        restMobileEnvelope(dto, 'recordCull'),
      ),
    );

    return {
      success: true,
      data: operation,
    };
  }

  /**
   * POST /api/tank-operations/transfer - Transfer kaydı
   */
  @Post('transfer')
  @HttpCode(HttpStatus.CREATED)
  async recordTransfer(@Req() req: TenantRequest, @Body() dto: RecordTransferDto) {
    const { tenantId, actorUserId, roles, assignedSiteIds } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new TransferBatchCommand(
        tenantId,
        dto.batchId,
        {
          sourceTankId: dto.tankId,
          destinationTankId: dto.destinationTankId,
          quantity: dto.quantity,
          biomassKg: dto.biomassKg,
          avgWeightG: dto.avgWeightG,
          transferReason: dto.reason,
          transferredAt: new Date(dto.operationDate),
          notes: dto.notes,
        },
        actorUserId,
        roles,
        assignedSiteIds,
        restMobileEnvelope(dto, 'transferBatch'),
      ),
    );

    return {
      success: true,
      data: operation,
      message: `${dto.quantity ?? `${dto.biomassKg}kg'dan türetilen`} adet ${dto.tankId} -> ${dto.destinationTankId} transfer edildi`,
    };
  }

  /**
   * POST /api/tank-operations/harvest - Hasat kaydı
   */
  @Post('harvest')
  @HttpCode(HttpStatus.CREATED)
  async recordHarvest(@Req() req: TenantRequest, @Body() dto: RecordHarvestDto) {
    const { tenantId, actorUserId, roles, assignedSiteIds } = verifiedContext(req);
    const totalBiomass = dto.totalWeightKg ?? (dto.quantity * (dto.avgWeightG ?? 0)) / 1000;

    const operation = await this.commandBus.execute(
      new CreateHarvestRecordCommand(
        tenantId,
        {
          tankId: dto.tankId,
          batchId: dto.batchId,
          quantityHarvested: dto.quantity,
          averageWeight: dto.avgWeightG ?? 0,
          totalBiomass,
          // Internal batch-harvest default; SUPERIOR preserves the prior
          // GRADE_A→SUPERIOR class mapping now that quality_class is the SSoT.
          qualityClass: QualityClass.SUPERIOR,
          harvestDate: new Date(dto.operationDate),
          pricePerKg: dto.pricePerKg,
          buyerName: dto.buyer,
          notes: dto.notes,
        },
        actorUserId,
        roles,
        assignedSiteIds,
      ),
    );

    return {
      success: true,
      data: operation,
    };
  }

  /**
   * GET /api/tank-operations/tank/:tankId - Tank'ın işlem geçmişi
   */
  @Get('tank/:tankId')
  async getTankOperations(
    @Req() req: TenantRequest,
    @Param('tankId', ParseUUIDPipe) tankId: string,
  ) {
    const { tenantId } = verifiedContext(req);
    const tankBatch = await this.batchService.getTankBatchStatus(tankId, tenantId);

    return {
      success: true,
      data: tankBatch,
    };
  }
}
