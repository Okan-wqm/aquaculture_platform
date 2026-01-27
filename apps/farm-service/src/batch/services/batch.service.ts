/**
 * Batch Service
 *
 * Batch yönetimi ve iş kuralları.
 * FCR, Survival Rate, Retention Rate hesaplamaları.
 *
 * @module Batch
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Batch, BatchStatus, BatchInputType } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType, MortalityReason, CullReason } from '../entities/tank-operation.entity';
import { Tank } from '../../tank/entities/tank.entity';

// ============================================================================
// DTOs
// ============================================================================

export interface CreateBatchInput {
  tenantId: string;
  batchNumber: string;
  speciesId: string;
  inputType: string;
  initialQuantity: number;
  initialAvgWeightG: number;
  stockedAt: Date;
  supplierId?: string;
  purchaseCost?: number;
  currency?: string;
  notes?: string;
  createdBy: string;
}

export interface AllocateBatchInput {
  batchId: string;
  tankId: string;
  quantity: number;
  avgWeightG: number;
  allocationType: AllocationType;
  allocatedBy: string;
  notes?: string;
}

export interface RecordOperationInput {
  tenantId: string;
  tankId: string;
  batchId: string;
  operationType: OperationType;
  operationDate: Date;
  quantity: number;
  avgWeightG?: number;
  reason?: string;
  detail?: string;
  destinationTankId?: string;
  performedBy: string;
  notes?: string;
}

/**
 * Batch detail info for tank summary
 */
export interface TankBatchDetail {
  batchId: string;
  batchNumber: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  percentageOfTank: number;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class BatchService {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankAllocation)
    private readonly allocationRepository: Repository<TankAllocation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  // -------------------------------------------------------------------------
  // BATCH CRUD
  // -------------------------------------------------------------------------

  /**
   * Yeni batch oluşturur
   */
  async createBatch(input: CreateBatchInput): Promise<Batch> {
    const initialBiomass = (input.initialQuantity * input.initialAvgWeightG) / 1000;

    const batch = this.batchRepository.create({
      tenantId: input.tenantId,
      batchNumber: input.batchNumber,
      speciesId: input.speciesId,
      inputType: input.inputType as BatchInputType,
      initialQuantity: input.initialQuantity,
      currentQuantity: input.initialQuantity,
      totalMortality: 0,
      cullCount: 0,
      totalFeedConsumed: 0,
      totalFeedCost: 0,
      stockedAt: input.stockedAt,
      supplierId: input.supplierId,
      purchaseCost: input.purchaseCost,
      currency: input.currency || 'TRY',
      status: BatchStatus.QUARANTINE,
      isActive: true,
      notes: input.notes,
      createdBy: input.createdBy,
      weight: {
        initial: {
          avgWeight: input.initialAvgWeightG,
          totalBiomass: initialBiomass,
          measuredAt: new Date(),
        },
        theoretical: {
          avgWeight: input.initialAvgWeightG,
          totalBiomass: initialBiomass,
          lastCalculatedAt: new Date(),
          basedOnFCR: 1.2, // Default FCR
        },
        actual: {
          avgWeight: input.initialAvgWeightG,
          totalBiomass: initialBiomass,
          lastMeasuredAt: new Date(),
          sampleSize: 0,
          confidencePercent: 0,
        },
        variance: {
          weightDifference: 0,
          percentageDifference: 0,
          isSignificant: false,
        },
      },
      fcr: {
        target: 1.2,
        actual: 0,
        theoretical: 1.2,
        isUserOverride: false,
        lastUpdatedAt: new Date(),
      },
      feedingSummary: {
        totalFeedGiven: 0,
        totalFeedCost: 0,
      },
      growthMetrics: {
        growthRate: {
          actual: 0,
          target: 0,
          variancePercent: 0,
        },
        daysInProduction: 0,
        projections: {
          confidenceLevel: 'low',
        },
      },
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
      },
    });

    return this.batchRepository.save(batch);
  }

  /**
   * Batch'i günceller
   */
  async updateBatch(id: string, tenantId: string, updates: Partial<Batch>): Promise<Batch> {
    const batch = await this.findBatchById(id, tenantId);
    Object.assign(batch, updates);
    return this.batchRepository.save(batch);
  }

  /**
   * Batch'i soft delete eder
   */
  async deleteBatch(id: string, tenantId: string, deletedBy: string): Promise<void> {
    const batch = await this.findBatchById(id, tenantId);
    batch.isActive = false;
    batch.status = BatchStatus.CLOSED;
    batch.updatedBy = deletedBy;
    await this.batchRepository.save(batch);
  }

  /**
   * Batch'i ID ile bulur
   */
  async findBatchById(id: string, tenantId: string): Promise<Batch> {
    const batch = await this.batchRepository.findOne({
      where: { id, tenantId, isActive: true },
      relations: ['species'],
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${id} bulunamadı`);
    }

    return batch;
  }

  /**
   * Tüm batch'leri listeler
   */
  async findAllBatches(
    tenantId: string,
    filters?: {
      status?: BatchStatus[];
      speciesId?: string;
      isActive?: boolean;
    },
  ): Promise<Batch[]> {
    const query = this.batchRepository.createQueryBuilder('batch')
      .where('batch.tenantId = :tenantId', { tenantId });

    if (filters?.status?.length) {
      query.andWhere('batch.status IN (:...statuses)', { statuses: filters.status });
    }

    if (filters?.speciesId) {
      query.andWhere('batch.speciesId = :speciesId', { speciesId: filters.speciesId });
    }

    if (filters?.isActive !== undefined) {
      query.andWhere('batch.isActive = :isActive', { isActive: filters.isActive });
    }

    query.orderBy('batch.stockedAt', 'DESC');

    return query.getMany();
  }

  // -------------------------------------------------------------------------
  // TANK ALLOCATION
  // -------------------------------------------------------------------------

  /**
   * Batch'i tank'a dağıtır
   */
  async allocateBatchToTank(input: AllocateBatchInput): Promise<TankAllocation> {
    const batch = await this.batchRepository.findOne({ where: { id: input.batchId } });
    if (!batch) {
      throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
    }

    const tank = await this.tankRepository.findOne({ where: { id: input.tankId } });
    if (!tank) {
      throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
    }

    const biomassKg = (input.quantity * input.avgWeightG) / 1000;
    const effectiveVolume = Number(tank.waterVolume || tank.volume) || 1;
    const densityKgM3 = effectiveVolume > 0 ? biomassKg / effectiveVolume : 0;

    // Allocation kaydı oluştur
    const allocation = this.allocationRepository.create({
      tenantId: batch.tenantId,
      batchId: input.batchId,
      tankId: input.tankId,
      allocationType: input.allocationType,
      allocationDate: new Date(),
      quantity: input.quantity,
      avgWeightG: input.avgWeightG,
      biomassKg,
      densityKgM3,
      allocatedBy: input.allocatedBy,
      notes: input.notes,
      isDeleted: false,
    });

    const savedAllocation = await this.allocationRepository.save(allocation);

    // TankBatch güncelle veya oluştur
    await this.updateTankBatch(batch.tenantId, input.tankId, input.batchId);

    // Batch durumunu ACTIVE yap
    if (batch.status === BatchStatus.QUARANTINE) {
      batch.status = BatchStatus.ACTIVE;
      batch.statusChangedAt = new Date();
      await this.batchRepository.save(batch);
    }

    return savedAllocation;
  }

  /**
   * TankBatch snapshot'ını günceller
   */
  private async updateTankBatch(
    tenantId: string,
    tankId: string,
    primaryBatchId?: string,
  ): Promise<TankBatch> {
    // Mevcut TankBatch bul veya oluştur
    let tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
    });

    // Aktif allocation'ları al
    const allocations = await this.allocationRepository.find({
      where: { tenantId, tankId, isDeleted: false },
      relations: ['batch'],
    });

    const tank = await this.tankRepository.findOne({ where: { id: tankId } });

    if (!tankBatch) {
      tankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId,
      });
    }

    // Toplam değerleri hesapla
    let totalQuantity = 0;
    let totalBiomass = 0;
    const batchDetails: TankBatchDetail[] = [];

    for (const alloc of allocations) {
      totalQuantity += alloc.quantity;
      totalBiomass += Number(alloc.biomassKg);

      batchDetails.push({
        batchId: alloc.batchId,
        batchNumber: alloc.batch?.batchNumber || '',
        quantity: alloc.quantity,
        avgWeightG: alloc.avgWeightG,
        biomassKg: alloc.biomassKg,
        percentageOfTank: 0, // Sonra hesaplanacak
      });
    }

    // Yüzdeleri hesapla
    if (totalQuantity > 0) {
      for (const detail of batchDetails) {
        detail.percentageOfTank = (detail.quantity / totalQuantity) * 100;
      }
    }

    // TankBatch güncelle
    tankBatch.primaryBatchId = primaryBatchId || batchDetails[0]?.batchId || undefined;
    tankBatch.totalQuantity = totalQuantity;
    tankBatch.totalBiomassKg = totalBiomass;
    tankBatch.avgWeightG = totalQuantity > 0 ? (totalBiomass * 1000) / totalQuantity : 0;
    const tankVolume = Number(tank?.waterVolume || tank?.volume) || 1;
    tankBatch.densityKgM3 = tankVolume > 0 ? totalBiomass / tankVolume : 0;
    tankBatch.isMixedBatch = batchDetails.length > 1;
    tankBatch.batchDetails = batchDetails.length > 1 ? batchDetails : undefined;

    // Kapasite kontrolü
    const maxDensity = Number(tank?.maxDensity) || 25; // kg/m³
    tankBatch.isOverCapacity = tankBatch.densityKgM3 > maxDensity;
    tankBatch.capacityUsedPercent = tankVolume > 0
      ? (tankBatch.densityKgM3 / maxDensity) * 100
      : undefined;

    return this.tankBatchRepository.save(tankBatch);
  }

  // -------------------------------------------------------------------------
  // TANK OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Tank operasyonu kaydeder (mortality, cull, transfer, harvest)
   */
  async recordOperation(input: RecordOperationInput): Promise<TankOperation> {
    const batch = await this.findBatchById(input.batchId, input.tenantId);
    const tank = await this.tankRepository.findOne({ where: { id: input.tankId } });

    if (!tank) {
      throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
    }

    // Pre-operation state
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId: input.tenantId, tankId: input.tankId },
    });

    const preOperationState = tankBatch ? {
      quantity: tankBatch.totalQuantity,
      biomassKg: tankBatch.totalBiomassKg,
      densityKgM3: tankBatch.densityKgM3,
    } : undefined;

    // Biomass hesapla
    const biomassKg = input.avgWeightG
      ? (input.quantity * input.avgWeightG) / 1000
      : undefined;

    // Operation kaydı oluştur
    const operation = this.operationRepository.create({
      tenantId: input.tenantId,
      tankId: input.tankId,
      batchId: input.batchId,
      operationType: input.operationType,
      operationDate: input.operationDate,
      quantity: input.quantity,
      avgWeightG: input.avgWeightG,
      biomassKg,
      preOperationState,
      performedBy: input.performedBy,
      notes: input.notes,
      isDeleted: false,
    });

    // Operation tipine göre ek alanları doldur
    switch (input.operationType) {
      case OperationType.MORTALITY:
        operation.mortalityReason = input.reason as MortalityReason | undefined;
        operation.mortalityDetail = input.detail;
        break;
      case OperationType.CULL:
        operation.cullReason = input.reason as CullReason | undefined;
        operation.cullDetail = input.detail;
        break;
      case OperationType.TRANSFER_OUT:
        operation.destinationTankId = input.destinationTankId;
        operation.transferReason = input.reason;
        break;
    }

    const savedOperation = await this.operationRepository.save(operation);

    // Batch metriklerini güncelle
    await this.updateBatchAfterOperation(batch, input);

    // Post-operation state
    const updatedTankBatch = await this.updateTankBatch(
      input.tenantId,
      input.tankId,
      input.batchId,
    );

    savedOperation.postOperationState = {
      quantity: updatedTankBatch.totalQuantity,
      biomassKg: updatedTankBatch.totalBiomassKg,
      densityKgM3: updatedTankBatch.densityKgM3,
    };

    return this.operationRepository.save(savedOperation);
  }

  /**
   * Operasyon sonrası batch'i günceller
   */
  private async updateBatchAfterOperation(
    batch: Batch,
    input: RecordOperationInput,
  ): Promise<void> {
    switch (input.operationType) {
      case OperationType.MORTALITY:
        batch.totalMortality += input.quantity;
        batch.currentQuantity -= input.quantity;
        batch.mortalitySummary.totalMortality = batch.totalMortality;
        batch.mortalitySummary.mortalityRate = batch.getMortalityRate();
        batch.mortalitySummary.lastMortalityAt = input.operationDate;
        break;

      case OperationType.CULL:
        batch.cullCount += input.quantity;
        batch.currentQuantity -= input.quantity;
        break;

      case OperationType.TRANSFER_OUT:
        batch.currentQuantity -= input.quantity;
        break;

      case OperationType.TRANSFER_IN:
        batch.currentQuantity += input.quantity;
        break;

      case OperationType.HARVEST:
        batch.harvestedQuantity = (batch.harvestedQuantity || 0) + input.quantity;
        batch.currentQuantity -= input.quantity;
        if (batch.currentQuantity <= 0) {
          batch.status = BatchStatus.HARVESTED;
          batch.statusChangedAt = new Date();
          batch.actualHarvestDate = input.operationDate;
        }
        break;
    }

    // Retention Rate güncelle
    batch.retentionRate = batch.getRetentionRate();

    await this.batchRepository.save(batch);
  }

  // -------------------------------------------------------------------------
  // METRICS HESAPLAMA
  // -------------------------------------------------------------------------

  /**
   * FCR hesaplar (Correct Formula)
   * FCR = totalFeedConsumed / weightGain
   * weightGain = finalBiomass - initialBiomass + mortalityBiomass
   */
  async calculateFCR(batchId: string, tenantId: string): Promise<number> {
    const batch = await this.findBatchById(batchId, tenantId);

    // Mortality'den kayıp biomass'ı hesapla
    const operations = await this.operationRepository.find({
      where: {
        tenantId,
        batchId,
        operationType: OperationType.MORTALITY,
        isDeleted: false,
      },
    });

    let mortalityBiomass = 0;
    for (const op of operations) {
      if (op.biomassKg) {
        mortalityBiomass += Number(op.biomassKg);
      }
    }

    return batch.calculateFCR(mortalityBiomass);
  }

  /**
   * SGR hesaplar (Specific Growth Rate)
   * SGR = ((ln(finalWeight) - ln(initialWeight)) / days) * 100
   */
  async calculateSGR(batchId: string, tenantId: string): Promise<number> {
    const batch = await this.findBatchById(batchId, tenantId);
    return batch.calculateSGR();
  }

  /**
   * Tüm batch metriklerini günceller
   */
  async updateBatchMetrics(batchId: string, tenantId: string): Promise<Batch> {
    const batch = await this.findBatchById(batchId, tenantId);

    // FCR
    const fcr = await this.calculateFCR(batchId, tenantId);
    batch.fcr.actual = fcr;
    batch.fcr.lastUpdatedAt = new Date();

    // SGR
    batch.sgr = batch.calculateSGR();

    // Retention Rate
    batch.retentionRate = batch.getRetentionRate();

    // Growth Metrics
    batch.growthMetrics.daysInProduction = batch.getDaysInProduction();

    // Cost per kg
    const currentBiomass = batch.getCurrentBiomass();
    if (currentBiomass > 0) {
      const totalCost = (batch.purchaseCost || 0) + batch.totalFeedCost;
      batch.costPerKg = totalCost / currentBiomass;
    }

    return this.batchRepository.save(batch);
  }

  // -------------------------------------------------------------------------
  // TANK QUERIES
  // -------------------------------------------------------------------------

  /**
   * Tank'taki mevcut batch durumunu döner
   */
  async getTankBatchStatus(tankId: string, tenantId: string): Promise<TankBatch | null> {
    return this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
      relations: ['primaryBatch', 'tank'],
    });
  }

  /**
   * Batch'in tank dağılımını döner
   */
  async getBatchAllocations(batchId: string, tenantId: string): Promise<TankAllocation[]> {
    return this.allocationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { allocationDate: 'DESC' },
    });
  }

  /**
   * Batch'in operasyon geçmişini döner
   */
  async getBatchOperations(batchId: string, tenantId: string): Promise<TankOperation[]> {
    return this.operationRepository.find({
      where: { tenantId, batchId, isDeleted: false },
      relations: ['tank'],
      order: { operationDate: 'DESC' },
    });
  }
}
