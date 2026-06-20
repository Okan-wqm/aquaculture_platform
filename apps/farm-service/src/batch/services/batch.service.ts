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
import { Repository, In, DataSource } from 'typeorm';
import { Batch, BatchStatus, BatchInputType } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType, MortalityReason, CullReason } from '../entities/tank-operation.entity';
import { isMortalityReason, isCullReason } from '../entities/tank-operation.enums';
import { Tank } from '../../tank/entities/tank.entity';
import { MortalityCullPolicyService } from './mortality-cull-policy.service';

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
  tenantId: string;
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
    private readonly dataSource: DataSource,
    private readonly mortalityCullPolicy: MortalityCullPolicyService,
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
   * Uses transaction to ensure allocation and batch status updates succeed or fail together
   */
  async allocateBatchToTank(input: AllocateBatchInput): Promise<TankAllocation> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: input.batchId, tenantId: input.tenantId, isActive: true },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
      }

      const tank = await queryRunner.manager.findOne(Tank, {
        where: { id: input.tankId, tenantId: input.tenantId, isActive: true },
      });
      if (!tank) {
        throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
      }

      const biomassKg = (input.quantity * input.avgWeightG) / 1000;
      const effectiveVolume = Number(tank.waterVolume || tank.volume) || 1;
      const densityKgM3 = effectiveVolume > 0 ? biomassKg / effectiveVolume : 0;

      // Allocation kaydı oluştur
      const allocation = queryRunner.manager.create(TankAllocation, {
        tenantId: input.tenantId,
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

      const savedAllocation = await queryRunner.manager.save(allocation);

      // TankBatch güncelle veya oluştur (within transaction)
      await this.updateTankBatchWithManager(queryRunner.manager, input.tenantId, input.tankId, input.batchId);

      // Batch durumunu ACTIVE yap
      if (batch.status === BatchStatus.QUARANTINE) {
        batch.status = BatchStatus.ACTIVE;
        batch.statusChangedAt = new Date();
        await queryRunner.manager.save(batch);
      }

      await queryRunner.commitTransaction();
      return savedAllocation;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Batch'i bir tank'tan diğerine transfer eder
   * Uses transaction to ensure both source and destination updates succeed or fail together
   */
  async transferBatch(
    tenantId: string,
    batchId: string,
    sourceTankId: string,
    destinationTankId: string,
    quantity: number,
    avgWeightG: number,
    performedBy: string,
    notes?: string,
  ): Promise<{ sourceOperation: TankOperation; destinationOperation: TankOperation }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate batch
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // Validate source tank
      const sourceTank = await queryRunner.manager.findOne(Tank, {
        where: { id: sourceTankId, tenantId, isActive: true },
      });
      if (!sourceTank) {
        throw new NotFoundException(`Kaynak tank ${sourceTankId} bulunamadı`);
      }

      // Validate destination tank
      const destinationTank = await queryRunner.manager.findOne(Tank, {
        where: { id: destinationTankId, tenantId, isActive: true },
      });
      if (!destinationTank) {
        throw new NotFoundException(`Hedef tank ${destinationTankId} bulunamadı`);
      }

      // Check source tank has enough quantity
      const sourceTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: sourceTankId },
      });
      if (!sourceTankBatch || sourceTankBatch.totalQuantity < quantity) {
        throw new BadRequestException(
          `Kaynak tankta yeterli balık yok. Mevcut: ${sourceTankBatch?.totalQuantity || 0}, İstenen: ${quantity}`,
        );
      }

      const biomassKg = (quantity * avgWeightG) / 1000;
      const operationDate = new Date();

      // Create TRANSFER_OUT operation for source tank
      const sourceOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: sourceTankId,
        batchId,
        operationType: OperationType.TRANSFER_OUT,
        operationDate,
        quantity,
        avgWeightG,
        biomassKg,
        destinationTankId,
        transferReason: notes || 'Tank transfer',
        preOperationState: {
          quantity: sourceTankBatch.totalQuantity,
          biomassKg: sourceTankBatch.totalBiomassKg,
          densityKgM3: sourceTankBatch.densityKgM3,
        },
        performedBy,
        notes,
        isDeleted: false,
      });
      const savedSourceOperation = await queryRunner.manager.save(sourceOperation);

      // Create TRANSFER_IN operation for destination tank
      const destTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: destinationTankId },
      });

      const destinationOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: destinationTankId,
        batchId,
        operationType: OperationType.TRANSFER_IN,
        operationDate,
        quantity,
        avgWeightG,
        biomassKg,
        sourceTankId,
        transferReason: notes || 'Tank transfer',
        preOperationState: destTankBatch ? {
          quantity: destTankBatch.totalQuantity,
          biomassKg: destTankBatch.totalBiomassKg,
          densityKgM3: destTankBatch.densityKgM3,
        } : undefined,
        performedBy,
        notes,
        isDeleted: false,
      });
      const savedDestinationOperation = await queryRunner.manager.save(destinationOperation);

      // Update source tank allocation - reduce quantity
      const sourceAllocation = await queryRunner.manager.findOne(TankAllocation, {
        where: { tenantId, tankId: sourceTankId, batchId, isDeleted: false },
      });
      if (sourceAllocation) {
        sourceAllocation.quantity -= quantity;
        sourceAllocation.biomassKg = (sourceAllocation.quantity * sourceAllocation.avgWeightG) / 1000;
        if (sourceAllocation.quantity <= 0) {
          sourceAllocation.isDeleted = true;
        }
        await queryRunner.manager.save(sourceAllocation);
      }

      // Update or create destination tank allocation
      let destAllocation = await queryRunner.manager.findOne(TankAllocation, {
        where: { tenantId, tankId: destinationTankId, batchId, isDeleted: false },
      });
      if (destAllocation) {
        destAllocation.quantity += quantity;
        destAllocation.biomassKg = (destAllocation.quantity * destAllocation.avgWeightG) / 1000;
      } else {
        const destVolume = Number(destinationTank.waterVolume || destinationTank.volume) || 1;
        destAllocation = queryRunner.manager.create(TankAllocation, {
          tenantId,
          batchId,
          tankId: destinationTankId,
          allocationType: AllocationType.TRANSFER_IN,
          allocationDate: operationDate,
          quantity,
          avgWeightG,
          biomassKg,
          densityKgM3: destVolume > 0 ? biomassKg / destVolume : 0,
          allocatedBy: performedBy,
          notes: `Transfer from tank ${sourceTankId}`,
          isDeleted: false,
        });
      }
      await queryRunner.manager.save(destAllocation);

      // Update TankBatch snapshots for both tanks
      await this.updateTankBatchWithManager(queryRunner.manager, tenantId, sourceTankId, batchId);
      await this.updateTankBatchWithManager(queryRunner.manager, tenantId, destinationTankId, batchId);

      // Update post-operation states
      const updatedSourceTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: sourceTankId },
      });
      const updatedDestTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: destinationTankId },
      });

      savedSourceOperation.postOperationState = updatedSourceTankBatch ? {
        quantity: updatedSourceTankBatch.totalQuantity,
        biomassKg: updatedSourceTankBatch.totalBiomassKg,
        densityKgM3: updatedSourceTankBatch.densityKgM3,
      } : undefined;
      await queryRunner.manager.save(savedSourceOperation);

      savedDestinationOperation.postOperationState = updatedDestTankBatch ? {
        quantity: updatedDestTankBatch.totalQuantity,
        biomassKg: updatedDestTankBatch.totalBiomassKg,
        densityKgM3: updatedDestTankBatch.densityKgM3,
      } : undefined;
      await queryRunner.manager.save(savedDestinationOperation);

      await queryRunner.commitTransaction();

      return {
        sourceOperation: savedSourceOperation,
        destinationOperation: savedDestinationOperation,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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

    const tank = await this.tankRepository.findOne({ where: { id: tankId, tenantId, isActive: true } });

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

  /**
   * TankBatch snapshot'ını EntityManager ile günceller (for transaction support)
   */
  private async updateTankBatchWithManager(
    manager: import('typeorm').EntityManager,
    tenantId: string,
    tankId: string,
    primaryBatchId?: string,
  ): Promise<TankBatch> {
    // Mevcut TankBatch bul veya oluştur
    let tankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId },
    });

    // Aktif allocation'ları al
    const allocations = await manager.find(TankAllocation, {
      where: { tenantId, tankId, isDeleted: false },
      relations: ['batch'],
    });

    const tank = await manager.findOne(Tank, { where: { id: tankId, tenantId, isActive: true } });

    if (!tankBatch) {
      tankBatch = manager.create(TankBatch, {
        tenantId,
        tankId,
        cleanerFishBiomassKg: 0,
        cleanerFishQuantity: 0,
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

    return manager.save(tankBatch);
  }

  // -------------------------------------------------------------------------
  // TANK OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Tank operasyonu kaydeder (mortality, cull, transfer, harvest)
   */
  async recordOperation(input: RecordOperationInput): Promise<TankOperation> {
    const batch = await this.findBatchById(input.batchId, input.tenantId);
    const tank = await this.tankRepository.findOne({
      where: { id: input.tankId, tenantId: input.tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
    }

    this.assertStockRemovalAllowed(batch, input);

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
        // FARM-MEDIUM-052: validate against the SSoT enum instead of an unchecked
        // cast. A missing reason stays undefined; an unknown string falls back to
        // OTHER rather than being unsafely asserted (which silently persisted an
        // out-of-range label, e.g. the old PREDATION/CANNIBALISM coercion).
        operation.mortalityReason =
          input.reason == null
            ? undefined
            : isMortalityReason(input.reason)
              ? input.reason
              : MortalityReason.OTHER;
        operation.mortalityDetail = input.detail;
        break;
      case OperationType.CULL:
        operation.cullReason =
          input.reason == null
            ? undefined
            : isCullReason(input.reason)
              ? input.reason
              : CullReason.OTHER;
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

  private assertStockRemovalAllowed(batch: Batch, input: RecordOperationInput): void {
    if (
      input.operationType !== OperationType.MORTALITY &&
      input.operationType !== OperationType.CULL
    ) {
      return;
    }

    const operation = input.operationType === OperationType.MORTALITY ? 'Mortality' : 'Cull';
    this.mortalityCullPolicy.assertStockMutable(batch);
    this.mortalityCullPolicy.assertQuantityWithinCurrent({
      operation,
      quantity: input.quantity,
      currentQuantity: batch.currentQuantity,
    });
    this.mortalityCullPolicy.assertAggregateWithinInitial({
      batch,
      addedRemoval: input.quantity,
    });
  }

  // -------------------------------------------------------------------------
  // METRICS HESAPLAMA — removed.
  //
  // The former calculateFCR / calculateSGR / updateBatchMetrics trio here was a
  // maintained-but-unrun shadow SSoT with ZERO production callers: it persisted
  // batch.fcr.actual from the entity's naive ledger-blind weight-gain formula,
  // a fourth FCR computation diverging from FcrCalculationService. FCR is now
  // computed on read by the single authority
  // (FcrCalculationService.calculateCumulativeFCR). SGR remains on the entity
  // (calculateSGR) and the SGRCalculatorService for the running callers. Cost
  // per kg is computed by BatchCostCalculatorService.
  // -------------------------------------------------------------------------

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
