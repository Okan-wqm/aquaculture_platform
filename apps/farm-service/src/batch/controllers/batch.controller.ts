/**
 * Batch Controller
 *
 * REST API endpoints for batch management.
 *
 * @module Batch
 */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  HttpStatus,
  HttpCode,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { BatchService, CreateBatchInput, AllocateBatchInput, RecordOperationInput } from '../services/batch.service';
import { BatchStatus } from '../entities/batch.entity';
import { AllocationType } from '../entities/tank-allocation.entity';
import { OperationType } from '../entities/tank-operation.entity';

/**
 * Interface for batch list filters
 */
interface BatchListFilters {
  status?: BatchStatus[];
  speciesId?: string;
  isActive?: boolean;
}

/**
 * Interface for batch update payload
 */
interface BatchUpdatePayload {
  name?: string;
  description?: string;
  status?: BatchStatus;
  expectedHarvestDate?: Date;
  notes?: string;
  updatedBy: string;
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

// ============================================================================
// CONTROLLER
// ============================================================================

@Controller('batches')
export class BatchController {
  constructor(private readonly batchService: BatchService) {}

  // -------------------------------------------------------------------------
  // BATCH CRUD
  // -------------------------------------------------------------------------

  /**
   * POST /api/batches - Yeni batch oluştur
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBatch(
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: CreateBatchDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: CreateBatchInput = {
      tenantId,
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
      createdBy: userId || 'system',
    };

    const batch = await this.batchService.createBatch(input);

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
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: BatchListQueryDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

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
    @Headers('x-tenant-id') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

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
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBatchDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const updates: BatchUpdatePayload = {
      name: dto.name,
      description: dto.description,
      status: dto.status,
      notes: dto.notes,
      updatedBy: userId || 'system',
    };

    if (dto.expectedHarvestDate) {
      updates.expectedHarvestDate = new Date(dto.expectedHarvestDate);
    }

    const batch = await this.batchService.updateBatch(id, tenantId, updates);

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
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    await this.batchService.deleteBatch(id, tenantId, userId || 'system');
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
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Param('id', ParseUUIDPipe) batchId: string,
    @Body() dto: AllocateBatchDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: AllocateBatchInput = {
      batchId,
      tankId: dto.tankId,
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      allocationType: dto.allocationType,
      allocatedBy: userId || 'system',
      notes: dto.notes,
    };

    const allocation = await this.batchService.allocateBatchToTank(input);

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
    @Headers('x-tenant-id') tenantId: string,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

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
    @Headers('x-tenant-id') tenantId: string,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

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
    @Headers('x-tenant-id') tenantId: string,
    @Param('id', ParseUUIDPipe) batchId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

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

@Controller('tank-operations')
export class TankOperationsController {
  constructor(private readonly batchService: BatchService) {}

  /**
   * POST /api/tank-operations/mortality - Ölüm kaydı
   */
  @Post('mortality')
  @HttpCode(HttpStatus.CREATED)
  async recordMortality(
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: RecordMortalityDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: RecordOperationInput = {
      tenantId,
      tankId: dto.tankId,
      batchId: dto.batchId,
      operationType: OperationType.MORTALITY,
      operationDate: new Date(dto.operationDate),
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      reason: dto.reason,
      detail: dto.detail,
      performedBy: userId || 'system',
      notes: dto.notes,
    };

    const operation = await this.batchService.recordOperation(input);

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
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: RecordCullDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: RecordOperationInput = {
      tenantId,
      tankId: dto.tankId,
      batchId: dto.batchId,
      operationType: OperationType.CULL,
      operationDate: new Date(dto.operationDate),
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      reason: dto.reason,
      detail: dto.detail,
      performedBy: userId || 'system',
      notes: dto.notes,
    };

    const operation = await this.batchService.recordOperation(input);

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
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: RecordTransferDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    // Source tank'tan çıkış
    const transferOut: RecordOperationInput = {
      tenantId,
      tankId: dto.tankId,
      batchId: dto.batchId,
      operationType: OperationType.TRANSFER_OUT,
      operationDate: new Date(dto.operationDate),
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      destinationTankId: dto.destinationTankId,
      reason: dto.reason,
      performedBy: userId || 'system',
      notes: dto.notes,
    };

    await this.batchService.recordOperation(transferOut);

    // Destination tank'a giriş
    const transferIn: RecordOperationInput = {
      tenantId,
      tankId: dto.destinationTankId,
      batchId: dto.batchId,
      operationType: OperationType.TRANSFER_IN,
      operationDate: new Date(dto.operationDate),
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      performedBy: userId || 'system',
      notes: dto.notes,
    };

    const operation = await this.batchService.recordOperation(transferIn);

    return {
      success: true,
      data: operation,
      message: `${dto.quantity} adet ${dto.tankId} → ${dto.destinationTankId} transfer edildi`,
    };
  }

  /**
   * POST /api/tank-operations/harvest - Hasat kaydı
   */
  @Post('harvest')
  @HttpCode(HttpStatus.CREATED)
  async recordHarvest(
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: RecordHarvestDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: RecordOperationInput = {
      tenantId,
      tankId: dto.tankId,
      batchId: dto.batchId,
      operationType: OperationType.HARVEST,
      operationDate: new Date(dto.operationDate),
      quantity: dto.quantity,
      avgWeightG: dto.avgWeightG,
      performedBy: userId || 'system',
      notes: dto.notes,
    };

    const operation = await this.batchService.recordOperation(input);

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
    @Headers('x-tenant-id') tenantId: string,
    @Param('tankId', ParseUUIDPipe) tankId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const tankBatch = await this.batchService.getTankBatchStatus(tankId, tenantId);

    return {
      success: true,
      data: tankBatch,
    };
  }
}
