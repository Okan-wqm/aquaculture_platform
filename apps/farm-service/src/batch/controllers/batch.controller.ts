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
import { QualityGrade } from '../../harvest/entities/harvest-record.entity';
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
}

// ============================================================================
// DTOs
// ============================================================================

class CreateBatchDto {
  batchNumber: string;
  speciesId: string;
  inputType: string;
  initialQuantity: number;
  initialAvgWeightG: number;
  stockedAt: string;
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
  tankId: string;
  quantity: number;
  avgWeightG: number;
  allocationType: AllocationType;
  notes?: string;
}

class RecordMortalityDto {
  tankId: string;
  batchId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: string;
  detail?: string;
  notes?: string;
}

class RecordCullDto {
  tankId: string;
  batchId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: string;
  detail?: string;
  notes?: string;
}

class RecordTransferDto {
  tankId: string;
  batchId: string;
  destinationTankId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: string;
  notes?: string;
}

class RecordHarvestDto {
  tankId: string;
  batchId: string;
  operationDate: string;
  quantity: number;
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
  const tenantId = req.verifiedUserAssertion?.effectiveTenantId ?? req.user?.tenantId ?? req.tenantId;
  const actorUserId = req.verifiedUserAssertion?.subject ?? req.user?.sub;

  if (!tenantId || !actorUserId) {
    throw new BadRequestException('Verified tenant context is required');
  }

  return {
    tenantId,
    actorUserId,
    roles: (req.verifiedUserAssertion?.roles ?? req.user?.roles ?? []) as Role[],
  };
}

function parseMortalityReason(value: string | undefined): MortalityReason {
  return Object.values(MortalityReason).includes(value as MortalityReason)
    ? (value as MortalityReason)
    : MortalityReason.OTHER;
}

function parseCullReason(value: string | undefined): CullReason {
  return Object.values(CullReason).includes(value as CullReason)
    ? (value as CullReason)
    : CullReason.OTHER;
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
  async createBatch(
    @Req() req: TenantRequest,
    @Body() dto: CreateBatchDto,
  ) {
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
  async listBatches(
    @Req() req: TenantRequest,
    @Query() query: BatchListQueryDto,
  ) {
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
  async getBatch(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
  async deleteBatch(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
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
    const { tenantId, actorUserId, roles } = verifiedContext(req);

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
  async getBatchOperations(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
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
  async getBatchMetrics(
    @Req() req: TenantRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
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
  ) {
    const { tenantId, actorUserId } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new RecordMortalityCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          reason: parseMortalityReason(dto.reason),
          detail: dto.detail,
          observedAt: new Date(dto.operationDate),
          observedBy: actorUserId,
          notes: dto.notes,
        },
        actorUserId,
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
  async recordCull(
    @Req() req: TenantRequest,
    @Body() dto: RecordCullDto,
  ) {
    const { tenantId, actorUserId } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new RecordCullCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          reason: parseCullReason(dto.reason),
          detail: dto.detail,
          culledAt: new Date(dto.operationDate),
          notes: dto.notes,
        },
        actorUserId,
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
  async recordTransfer(
    @Req() req: TenantRequest,
    @Body() dto: RecordTransferDto,
  ) {
    const { tenantId, actorUserId } = verifiedContext(req);

    const operation = await this.commandBus.execute(
      new TransferBatchCommand(
        tenantId,
        dto.batchId,
        {
          sourceTankId: dto.tankId,
          destinationTankId: dto.destinationTankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          transferReason: dto.reason,
          transferredAt: new Date(dto.operationDate),
          notes: dto.notes,
        },
        actorUserId,
      ),
    );

    return {
      success: true,
      data: operation,
      message: `${dto.quantity} adet ${dto.tankId} -> ${dto.destinationTankId} transfer edildi`,
    };
  }

  /**
   * POST /api/tank-operations/harvest - Hasat kaydı
   */
  @Post('harvest')
  @HttpCode(HttpStatus.CREATED)
  async recordHarvest(
    @Req() req: TenantRequest,
    @Body() dto: RecordHarvestDto,
  ) {
    const { tenantId, actorUserId } = verifiedContext(req);
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
          qualityGrade: QualityGrade.GRADE_A,
          harvestDate: new Date(dto.operationDate),
          pricePerKg: dto.pricePerKg,
          buyerName: dto.buyer,
          notes: dto.notes,
        },
        actorUserId,
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
