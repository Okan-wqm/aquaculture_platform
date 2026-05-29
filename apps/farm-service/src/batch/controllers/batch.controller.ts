/**
 * Batch Controller
 *
 * REST API endpoints for batch management.
 *
 * @module Batch
 */
import { Role } from '@aquaculture/backend-common/decorators';
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
import { CommandBus } from '@platform/cqrs';
import { Request } from 'express';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CreateHarvestRecordCommand } from '../../harvest/commands/create-harvest-record.command';
import { QualityGrade } from '../../harvest/entities/harvest-record.entity';
import { AllocateToTankCommand } from '../commands/allocate-to-tank.command';
import { BatchCloseReason, CloseBatchCommand } from '../commands/close-batch.command';
import { CreateBatchCommand, CreateBatchPayload } from '../commands/create-batch.command';
import { RecordCullCommand, CullReason } from '../commands/record-cull.command';
import { RecordMortalityCommand, MortalityReason } from '../commands/record-mortality.command';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { UpdateBatchStatusCommand } from '../commands/update-batch-status.command';
import { UpdateBatchCommand, UpdateBatchPayload } from '../commands/update-batch.command';
import { BatchInputType, BatchStatus } from '../entities/batch.entity';
import { AllocationType } from '../entities/tank-allocation.entity';
import { BatchService } from '../services/batch.service';

/**
 * Interface for batch list filters
 */
interface BatchListFilters {
  status?: BatchStatus[];
  speciesId?: string;
  isActive?: boolean;
}

interface AuthenticatedFarmRequest extends Request {
  tenantId?: string;
  user?: {
    sub?: string;
    tenantId?: string | null;
    roles?: Role[];
  };
}

function requireTenantId(req: AuthenticatedFarmRequest): string {
  const tenantId = req.tenantId ?? req.user?.tenantId ?? undefined;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new BadRequestException('Verified tenant context is required');
  }
  return tenantId;
}

function currentUserId(req: AuthenticatedFarmRequest): string {
  return req.user?.sub ?? 'system';
}

function currentUserRoles(req: AuthenticatedFarmRequest): Role[] {
  return Array.isArray(req.user?.roles) ? req.user.roles : [];
}

// ============================================================================
// DTOs
// ============================================================================

class CreateBatchDto {
  batchNumber: string;
  speciesId: string;
  inputType: BatchInputType;
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

// ============================================================================
// CONTROLLER
// ============================================================================

@UseGuards(JwtAuthGuard)
@Controller('batches')
export class BatchController {
  constructor(
    private readonly batchService: BatchService,
    private readonly commandBus: CommandBus,
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
    @Req() req: AuthenticatedFarmRequest,
    @Body() dto: CreateBatchDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const payload: CreateBatchPayload = {
      batchNumber: dto.batchNumber,
      speciesId: dto.speciesId,
      inputType: dto.inputType,
      initialQuantity: dto.initialQuantity,
      initialAvgWeightG: dto.initialAvgWeightG,
      stockedAt: new Date(dto.stockedAt),
      supplierId: dto.supplierId,
      purchaseCost: dto.purchaseCost,
      currency: dto.currency,
      notes: dto.notes,
    };

    const batch = await this.commandBus.execute(new CreateBatchCommand(tenantId, payload, userId));

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
    @Req() req: AuthenticatedFarmRequest,
    @Query() query: BatchListQueryDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
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

    const batches = await this.batchService.findAllBatches(tenantId, filters);

    return {
      success: true,
      data: batches,
      total: batches.length,
    };
  }

  /**
   * GET /api/batches/:id - Batch detay
   */
  @Get(':id')
  async getBatch(
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const batch = await this.batchService.findBatchById(id, tenantId);

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
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBatchDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const updates: UpdateBatchPayload = {
      name: dto.name,
      description: dto.description,
      notes: dto.notes,
    };

    if (dto.expectedHarvestDate) {
      updates.expectedHarvestDate = new Date(dto.expectedHarvestDate);
    }

    const hasMetadataUpdate = Object.values(updates).some((value) => value !== undefined);

    let batch: unknown;
    if (hasMetadataUpdate) {
      batch = await this.commandBus.execute(new UpdateBatchCommand(tenantId, id, updates, userId));
    }

    if (dto.status !== undefined) {
      batch = await this.commandBus.execute(
        new UpdateBatchStatusCommand({
          tenantId,
          batchId: id,
          newStatus: dto.status,
          updatedBy: userId,
          reason: dto.notes,
        }),
      );
    }

    batch ??= await this.batchService.findBatchById(id, tenantId);

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * DELETE /api/batches/:id - Batch sil (soft delete)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBatch(
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    await this.commandBus.execute(
      new CloseBatchCommand({
        tenantId,
        batchId: id,
        reason: BatchCloseReason.CANCELLED,
        closedBy: userId,
        userRoles: currentUserRoles(req),
      }),
    );
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
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
    @Body() dto: AllocateBatchDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const allocation = await this.commandBus.execute(
      new AllocateToTankCommand(
        tenantId,
        batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          allocationType: dto.allocationType,
          allocatedAt: new Date(),
          notes: dto.notes,
        },
        userId,
        currentUserRoles(req),
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
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
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
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
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
    @Req() req: AuthenticatedFarmRequest,
    @Param('id', ParseUUIDPipe) batchId: string,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const batch = await this.batchService.updateBatchMetrics(batchId, tenantId);

    return {
      success: true,
      data: {
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        initialQuantity: batch.initialQuantity,
        currentQuantity: batch.currentQuantity,
        totalMortality: batch.totalMortality,
        cullCount: batch.cullCount,
        survivalRate: batch.getSurvivalRate(),
        retentionRate: batch.retentionRate,
        fcr: batch.fcr.actual,
        sgr: batch.sgr,
        daysInProduction: batch.getDaysInProduction(),
        currentBiomass: batch.getCurrentBiomass(),
        currentAvgWeight: batch.getCurrentAvgWeight(),
        totalFeedConsumed: batch.totalFeedConsumed,
        totalFeedCost: batch.totalFeedCost,
        costPerKg: batch.costPerKg,
      },
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
    private readonly batchService: BatchService,
    private readonly commandBus: CommandBus,
  ) {}

  /**
   * POST /api/tank-operations/mortality - Ölüm kaydı
   */
  @Post('mortality')
  @HttpCode(HttpStatus.CREATED)
  async recordMortality(
    @Req() req: AuthenticatedFarmRequest,
    @Body() dto: RecordMortalityDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const batch = await this.commandBus.execute(
      new RecordMortalityCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          reason: (dto.reason as MortalityReason | undefined) ?? MortalityReason.UNKNOWN,
          detail: dto.detail,
          observedAt: new Date(dto.operationDate),
          observedBy: userId,
          notes: dto.notes,
        },
        userId,
      ),
    );

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * POST /api/tank-operations/cull - Ayıklama kaydı
   */
  @Post('cull')
  @HttpCode(HttpStatus.CREATED)
  async recordCull(
    @Req() req: AuthenticatedFarmRequest,
    @Body() dto: RecordCullDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const batch = await this.commandBus.execute(
      new RecordCullCommand(
        tenantId,
        dto.batchId,
        {
          tankId: dto.tankId,
          quantity: dto.quantity,
          avgWeightG: dto.avgWeightG,
          reason: (dto.reason as CullReason | undefined) ?? CullReason.OTHER,
          detail: dto.detail,
          culledAt: new Date(dto.operationDate),
          notes: dto.notes,
        },
        userId,
      ),
    );

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * POST /api/tank-operations/transfer - Transfer kaydı
   */
  @Post('transfer')
  @HttpCode(HttpStatus.CREATED)
  async recordTransfer(
    @Req() req: AuthenticatedFarmRequest,
    @Body() dto: RecordTransferDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const batch = await this.commandBus.execute(
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
        userId,
      ),
    );

    return {
      success: true,
      data: batch,
      message: `${dto.quantity} adet ${dto.tankId} → ${dto.destinationTankId} transfer edildi`,
    };
  }

  /**
   * POST /api/tank-operations/harvest - Hasat kaydı
   */
  @Post('harvest')
  @HttpCode(HttpStatus.CREATED)
  async recordHarvest(
    @Req() req: AuthenticatedFarmRequest,
    @Body() dto: RecordHarvestDto,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const userId = currentUserId(req);

    const averageWeight =
      dto.avgWeightG ??
      (dto.totalWeightKg !== undefined && dto.quantity > 0
        ? (dto.totalWeightKg * 1000) / dto.quantity
        : 0);
    const totalBiomass = dto.totalWeightKg ?? (dto.quantity * averageWeight) / 1000;

    const harvest = await this.commandBus.execute(
      new CreateHarvestRecordCommand(
        tenantId,
        {
          batchId: dto.batchId,
          tankId: dto.tankId,
          quantityHarvested: dto.quantity,
          averageWeight,
          totalBiomass,
          qualityGrade: QualityGrade.GRADE_A,
          harvestDate: new Date(dto.operationDate),
          pricePerKg: dto.pricePerKg,
          buyerName: dto.buyer,
          notes: dto.notes,
        },
        userId,
      ),
    );

    return {
      success: true,
      data: harvest,
    };
  }

  /**
   * GET /api/tank-operations/tank/:tankId - Tank'ın işlem geçmişi
   */
  @Get('tank/:tankId')
  async getTankOperations(
    @Req() req: AuthenticatedFarmRequest,
    @Param('tankId', ParseUUIDPipe) tankId: string,
  ): Promise<unknown> {
    const tenantId = requireTenantId(req);
    const tankBatch = await this.batchService.getTankBatchStatus(tankId, tenantId);

    return {
      success: true,
      data: tankBatch,
    };
  }
}
