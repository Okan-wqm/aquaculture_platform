/**
 * TransferBatchHandler
 *
 * TransferBatchCommand'ı işler ve batch'i bir tank'tan diğerine transfer eder.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { Batch } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { findTankOrEquipment, TankLookupResult } from '../utils/tank-lookup.util';

// Note: TransferResult interface kept for internal tracking but handler returns Batch for GraphQL compatibility
export interface TransferResult {
  sourceOperation: TankOperation;
  destinationOperation: TankOperation;
  sourceAllocation: TankAllocation;
  destinationAllocation: TankAllocation;
}

@Injectable()
@CommandHandler(TransferBatchCommand)
export class TransferBatchHandler implements ICommandHandler<TransferBatchCommand, Batch> {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankAllocation)
    private readonly allocationRepository: Repository<TankAllocation>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: TransferBatchCommand): Promise<Batch> {
    const { tenantId, batchId, payload, transferredBy } = command;

    // Read operations for validation (outside transaction)
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    const sourceLookup = await findTankOrEquipment(
      this.equipmentRepository,
      this.tankRepository,
      this.equipmentTypeRepository,
      payload.sourceTankId,
      tenantId,
    );

    if (!sourceLookup) {
      throw new NotFoundException(`Kaynak tank ${payload.sourceTankId} bulunamadı`);
    }

    const sourceTank = sourceLookup.equipment;

    const destLookup = await findTankOrEquipment(
      this.equipmentRepository,
      this.tankRepository,
      this.equipmentTypeRepository,
      payload.destinationTankId,
      tenantId,
    );

    if (!destLookup) {
      throw new NotFoundException(`Hedef tank ${payload.destinationTankId} bulunamadı`);
    }

    const destinationTank = destLookup.equipment;

    if (payload.sourceTankId === payload.destinationTankId) {
      throw new BadRequestException('Kaynak ve hedef tank aynı olamaz');
    }

    const sourceTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.sourceTankId },
    });

    if (!sourceTankBatch) {
      throw new BadRequestException(`Kaynak tank ${sourceTank.code} boş`);
    }

    const batchInSource = sourceTankBatch.batchDetails?.find(b => b.batchId === batchId);
    const availableQuantity = batchInSource?.quantity || (sourceTankBatch.primaryBatchId === batchId ? sourceTankBatch.totalQuantity : 0);

    if (payload.quantity > availableQuantity) {
      throw new BadRequestException(
        `Transfer miktarı (${payload.quantity}) kaynak tank'taki batch miktarından (${availableQuantity}) fazla olamaz`
      );
    }

    const avgWeightG = payload.avgWeightG ||
      batchInSource?.avgWeightG ||
      sourceTankBatch.avgWeightG ||
      batch.getCurrentAvgWeight();

    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    if (!payload.skipCapacityCheck && !destinationTank.hasCapacityFor(biomassKg)) {
      throw new BadRequestException(
        `Hedef tank ${destinationTank.code} kapasitesi yetersiz`
      );
    }

    // Start transaction for all write operations
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transferDate = payload.transferredAt || new Date();

      // Source tank pre-operation state
      const sourcePreState = {
        quantity: sourceTankBatch.totalQuantity,
        biomassKg: sourceTankBatch.totalBiomassKg,
        densityKgM3: sourceTankBatch.densityKgM3,
      };

      // 1. Kaynak tank'tan çıkış operation
      const sourceOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: payload.sourceTankId,
        batchId,
        operationType: OperationType.TRANSFER_OUT,
        operationDate: transferDate,
        quantity: payload.quantity,
        avgWeightG,
        biomassKg,
        destinationTankId: payload.destinationTankId,
        transferReason: payload.transferReason,
        preOperationState: sourcePreState,
        performedBy: transferredBy,
        notes: payload.notes,
        isDeleted: false,
      });

      const savedSourceOp = await queryRunner.manager.save(TankOperation, sourceOperation);

      // 2. Kaynak tank allocation (çıkış)
      const sourceAllocation = queryRunner.manager.create(TankAllocation, {
        tenantId,
        batchId,
        tankId: payload.sourceTankId,
        allocationType: AllocationType.TRANSFER_OUT,
        allocationDate: transferDate,
        quantity: -payload.quantity,
        avgWeightG,
        biomassKg: -biomassKg,
        batchNumber: batch.batchNumber,
        tankCode: sourceTank.code,
        tankName: sourceTank.name,
        allocatedBy: transferredBy,
        notes: `Transfer to ${destinationTank.code}`,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankAllocation, sourceAllocation);

      // 3. Hedef tank'a giriş operation
      const destTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.destinationTankId },
      });

      const destPreState = destTankBatch ? {
        quantity: destTankBatch.totalQuantity,
        biomassKg: destTankBatch.totalBiomassKg,
        densityKgM3: destTankBatch.densityKgM3,
      } : { quantity: 0, biomassKg: 0, densityKgM3: 0 };

      const destOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: payload.destinationTankId,
        batchId,
        operationType: OperationType.TRANSFER_IN,
        operationDate: transferDate,
        quantity: payload.quantity,
        avgWeightG,
        biomassKg,
        sourceTankId: payload.sourceTankId,
        transferReason: payload.transferReason,
        preOperationState: destPreState,
        performedBy: transferredBy,
        notes: payload.notes,
        isDeleted: false,
      });

      const savedDestOp = await queryRunner.manager.save(TankOperation, destOperation);

      // 4. Hedef tank allocation (giriş)
      const destEffectiveVolume = destinationTank.volume || 0;
      const destDensity = destEffectiveVolume ? biomassKg / Number(destEffectiveVolume) : 0;

      const destAllocation = queryRunner.manager.create(TankAllocation, {
        tenantId,
        batchId,
        tankId: payload.destinationTankId,
        allocationType: AllocationType.TRANSFER_IN,
        allocationDate: transferDate,
        quantity: payload.quantity,
        avgWeightG,
        biomassKg,
        densityKgM3: destDensity,
        batchNumber: batch.batchNumber,
        tankCode: destinationTank.code,
        tankName: destinationTank.name,
        allocatedBy: transferredBy,
        notes: `Transfer from ${sourceTank.code}`,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankAllocation, destAllocation);

      // 5. TankBatch güncellemeleri
      await this.updateTankBatchWithManager(queryRunner.manager, tenantId, payload.sourceTankId, batchId, -payload.quantity, -biomassKg);
      await this.updateTankBatchWithManager(queryRunner.manager, tenantId, payload.destinationTankId, batchId, payload.quantity, biomassKg, batch.batchNumber);

      // 6. Tank/Equipment biomass güncellemeleri
      const newSourceBiomass = Number(sourceTank.currentBiomass || 0) - biomassKg;
      const newSourceCount = (sourceTank.currentCount || 0) - payload.quantity;
      if (sourceLookup.isFromTanksTable && sourceLookup.originalTank) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: newSourceBiomass, currentCount: newSourceCount })
          .where('id = :id', { id: sourceLookup.originalTank.id })
          .execute();
      } else {
        sourceTank.currentBiomass = newSourceBiomass;
        sourceTank.currentCount = newSourceCount;
        await queryRunner.manager.save(Equipment, sourceTank);
      }

      const newDestBiomass = Number(destinationTank.currentBiomass || 0) + biomassKg;
      const newDestCount = (destinationTank.currentCount || 0) + payload.quantity;
      if (destLookup.isFromTanksTable && destLookup.originalTank) {
        const destOriginalTank = destLookup.originalTank;
        // Activate tank if it was preparing/fallow
        const shouldActivate = destOriginalTank.status === 'preparing' || destOriginalTank.status === 'fallow';
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({
            currentBiomass: newDestBiomass,
            currentCount: newDestCount,
            ...(shouldActivate ? { status: TankStatus.ACTIVE } : {}),
          })
          .where('id = :id', { id: destOriginalTank.id })
          .execute();
      } else {
        destinationTank.currentBiomass = newDestBiomass;
        destinationTank.currentCount = newDestCount;
        if (destinationTank.status === EquipmentStatus.PREPARING || destinationTank.status === EquipmentStatus.FALLOW) {
          destinationTank.status = EquipmentStatus.ACTIVE;
        }
        await queryRunner.manager.save(Equipment, destinationTank);
      }

      // Post-operation states güncelle
      const updatedSourceTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.sourceTankId },
      });
      const updatedDestTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.destinationTankId },
      });

      if (updatedSourceTankBatch) {
        savedSourceOp.postOperationState = {
          quantity: updatedSourceTankBatch.totalQuantity,
          biomassKg: updatedSourceTankBatch.totalBiomassKg,
          densityKgM3: updatedSourceTankBatch.densityKgM3,
        };
        await queryRunner.manager.save(TankOperation, savedSourceOp);
      }

      if (updatedDestTankBatch) {
        savedDestOp.postOperationState = {
          quantity: updatedDestTankBatch.totalQuantity,
          biomassKg: updatedDestTankBatch.totalBiomassKg,
          densityKgM3: updatedDestTankBatch.densityKgM3,
        };
        await queryRunner.manager.save(TankOperation, savedDestOp);
      }

      // Commit transaction
      await queryRunner.commitTransaction();

      return batch;
    } catch (error) {
      // Rollback transaction on any error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // Release query runner
      await queryRunner.release();
    }
  }

  /**
   * Transaction-aware TankBatch update using EntityManager
   */
  private async updateTankBatchWithManager(
    manager: EntityManager,
    tenantId: string,
    tankId: string,
    batchId: string,
    quantityDelta: number,
    biomassDelta: number,
    batchNumber?: string,
  ): Promise<void> {
    let tankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId },
    });

    const equipment = await manager.findOne(Equipment, { where: { id: tankId } });
    const effectiveVolume = equipment?.volume || 0;

    if (!tankBatch && quantityDelta > 0) {
      // Yeni TankBatch oluştur
      tankBatch = manager.create(TankBatch, {
        tenantId,
        tankId,
        primaryBatchId: batchId,
        primaryBatchNumber: batchNumber,
        tankCode: equipment?.code,
        tankName: equipment?.name,
        totalQuantity: quantityDelta,
        totalBiomassKg: biomassDelta,
        avgWeightG: quantityDelta > 0 ? (biomassDelta * 1000) / quantityDelta : 0,
        densityKgM3: effectiveVolume ? biomassDelta / Number(effectiveVolume) : 0,
        isMixedBatch: false,
        isOverCapacity: false,
      });
    } else if (tankBatch) {
      // Ensure numeric operations (database may return decimal columns as strings)
      tankBatch.totalQuantity = Number(tankBatch.totalQuantity) + quantityDelta;
      tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) + biomassDelta;

      if (tankBatch.totalQuantity > 0) {
        tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
        tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
      } else {
        // Tank boşaldı
        tankBatch.avgWeightG = 0;
        tankBatch.densityKgM3 = 0;
        tankBatch.primaryBatchId = undefined;
        tankBatch.batchDetails = undefined;
      }

      // Kapasite kontrolü
      const specs = equipment?.specifications as { maxDensity?: number } | undefined;
      const maxDensity = specs?.maxDensity || 30;
      tankBatch.isOverCapacity = tankBatch.densityKgM3 > maxDensity;
      tankBatch.capacityUsedPercent = (tankBatch.densityKgM3 / maxDensity) * 100;
    }

    if (tankBatch) {
      await manager.save(TankBatch, tankBatch);
    }
  }

  /**
   * @deprecated Use updateTankBatchWithManager for transaction support
   */
  private async updateTankBatchAfterTransfer(
    tenantId: string,
    tankId: string,
    batchId: string,
    quantityDelta: number,
    biomassDelta: number,
    batchNumber?: string,
  ): Promise<void> {
    let tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
    });

    const equipment = await this.equipmentRepository.findOne({ where: { id: tankId } });
    const effectiveVolume = equipment?.volume || 0;

    if (!tankBatch && quantityDelta > 0) {
      // Yeni TankBatch oluştur
      tankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId,
        primaryBatchId: batchId,
        primaryBatchNumber: batchNumber,
        tankCode: equipment?.code,
        tankName: equipment?.name,
        totalQuantity: quantityDelta,
        totalBiomassKg: biomassDelta,
        avgWeightG: quantityDelta > 0 ? (biomassDelta * 1000) / quantityDelta : 0,
        densityKgM3: effectiveVolume ? biomassDelta / Number(effectiveVolume) : 0,
        isMixedBatch: false,
        isOverCapacity: false,
      });
    } else if (tankBatch) {
      // Ensure numeric operations (database may return decimal columns as strings)
      tankBatch.totalQuantity = Number(tankBatch.totalQuantity) + quantityDelta;
      tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) + biomassDelta;

      if (tankBatch.totalQuantity > 0) {
        tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
        tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
      } else {
        // Tank boşaldı
        tankBatch.avgWeightG = 0;
        tankBatch.densityKgM3 = 0;
        tankBatch.primaryBatchId = undefined;
        tankBatch.batchDetails = undefined;
      }

      // Kapasite kontrolü
      const specs = equipment?.specifications as { maxDensity?: number } | undefined;
      const maxDensity = specs?.maxDensity || 30;
      tankBatch.isOverCapacity = tankBatch.densityKgM3 > maxDensity;
      tankBatch.capacityUsedPercent = (tankBatch.densityKgM3 / maxDensity) * 100;
    }

    if (tankBatch) {
      await this.tankBatchRepository.save(tankBatch);
    }
  }
}
