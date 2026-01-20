/**
 * TransferBatchHandler
 *
 * TransferBatchCommand'ı işler ve batch'i bir tank'tan diğerine transfer eder.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { Batch } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';

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
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: TransferBatchCommand): Promise<Batch> {
    const { tenantId, batchId, payload, transferredBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Kaynak ve hedef ekipmanları (tank/pond/cage) bul
    const sourceTank = await this.equipmentRepository.findOne({
      where: { id: payload.sourceTankId, tenantId, isActive: true },
    });

    if (!sourceTank) {
      throw new NotFoundException(`Kaynak tank ${payload.sourceTankId} bulunamadı`);
    }

    const destinationTank = await this.equipmentRepository.findOne({
      where: { id: payload.destinationTankId, tenantId, isActive: true },
    });

    if (!destinationTank) {
      throw new NotFoundException(`Hedef tank ${payload.destinationTankId} bulunamadı`);
    }

    // Aynı tank'a transfer kontrolü
    if (payload.sourceTankId === payload.destinationTankId) {
      throw new BadRequestException('Kaynak ve hedef tank aynı olamaz');
    }

    // Kaynak tank'ta batch kontrolü
    const sourceTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.sourceTankId },
    });

    if (!sourceTankBatch) {
      throw new BadRequestException(`Kaynak tank ${sourceTank.code} boş`);
    }

    // Batch miktarı kontrolü
    const batchInSource = sourceTankBatch.batchDetails?.find(b => b.batchId === batchId);
    const availableQuantity = batchInSource?.quantity || (sourceTankBatch.primaryBatchId === batchId ? sourceTankBatch.totalQuantity : 0);

    if (payload.quantity > availableQuantity) {
      throw new BadRequestException(
        `Transfer miktarı (${payload.quantity}) kaynak tank'taki batch miktarından (${availableQuantity}) fazla olamaz`
      );
    }

    // Ağırlık belirleme
    const avgWeightG = payload.avgWeightG ||
      batchInSource?.avgWeightG ||
      sourceTankBatch.avgWeightG ||
      batch.getCurrentAvgWeight();

    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // Hedef tank kapasite kontrolü (skipCapacityCheck ile atlanabilir)
    if (!payload.skipCapacityCheck && !destinationTank.hasCapacityFor(biomassKg)) {
      throw new BadRequestException(
        `Hedef tank ${destinationTank.code} kapasitesi yetersiz`
      );
    }

    const transferDate = payload.transferredAt || new Date();

    // Source tank pre-operation state
    const sourcePreState = {
      quantity: sourceTankBatch.totalQuantity,
      biomassKg: sourceTankBatch.totalBiomassKg,
      densityKgM3: sourceTankBatch.densityKgM3,
    };

    // 1. Kaynak tank'tan çıkış operation
    const sourceOperation = this.operationRepository.create({
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

    const savedSourceOp = await this.operationRepository.save(sourceOperation);

    // 2. Kaynak tank allocation (çıkış)
    const sourceAllocation = this.allocationRepository.create({
      tenantId,
      batchId,
      tankId: payload.sourceTankId,
      allocationType: AllocationType.TRANSFER_OUT,
      allocationDate: transferDate,
      quantity: -payload.quantity, // Negatif (çıkış)
      avgWeightG,
      biomassKg: -biomassKg,
      batchNumber: batch.batchNumber,
      tankCode: sourceTank.code,
      tankName: sourceTank.name,
      allocatedBy: transferredBy,
      notes: `Transfer to ${destinationTank.code}`,
      isDeleted: false,
    });

    const savedSourceAlloc = await this.allocationRepository.save(sourceAllocation);

    // 3. Hedef tank'a giriş operation
    const destTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.destinationTankId },
    });

    const destPreState = destTankBatch ? {
      quantity: destTankBatch.totalQuantity,
      biomassKg: destTankBatch.totalBiomassKg,
      densityKgM3: destTankBatch.densityKgM3,
    } : { quantity: 0, biomassKg: 0, densityKgM3: 0 };

    const destOperation = this.operationRepository.create({
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

    const savedDestOp = await this.operationRepository.save(destOperation);

    // 4. Hedef tank allocation (giriş)
    const destEffectiveVolume = destinationTank.volume || 0;
    const destDensity = destEffectiveVolume ? biomassKg / Number(destEffectiveVolume) : 0;

    const destAllocation = this.allocationRepository.create({
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

    const savedDestAlloc = await this.allocationRepository.save(destAllocation);

    // 5. TankBatch güncellemeleri
    await this.updateTankBatchAfterTransfer(tenantId, payload.sourceTankId, batchId, -payload.quantity, -biomassKg);
    await this.updateTankBatchAfterTransfer(tenantId, payload.destinationTankId, batchId, payload.quantity, biomassKg, batch.batchNumber);

    // 6. Equipment güncellemeleri
    sourceTank.currentBiomass = Number(sourceTank.currentBiomass || 0) - biomassKg;
    sourceTank.currentCount = (sourceTank.currentCount || 0) - payload.quantity;
    await this.equipmentRepository.save(sourceTank);

    destinationTank.currentBiomass = Number(destinationTank.currentBiomass || 0) + biomassKg;
    destinationTank.currentCount = (destinationTank.currentCount || 0) + payload.quantity;
    if (destinationTank.status === EquipmentStatus.PREPARING || destinationTank.status === EquipmentStatus.FALLOW) {
      destinationTank.status = EquipmentStatus.ACTIVE;
    }
    await this.equipmentRepository.save(destinationTank);

    // Post-operation states güncelle
    const updatedSourceTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.sourceTankId },
    });
    const updatedDestTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.destinationTankId },
    });

    if (updatedSourceTankBatch) {
      savedSourceOp.postOperationState = {
        quantity: updatedSourceTankBatch.totalQuantity,
        biomassKg: updatedSourceTankBatch.totalBiomassKg,
        densityKgM3: updatedSourceTankBatch.densityKgM3,
      };
      await this.operationRepository.save(savedSourceOp);
    }

    if (updatedDestTankBatch) {
      savedDestOp.postOperationState = {
        quantity: updatedDestTankBatch.totalQuantity,
        biomassKg: updatedDestTankBatch.totalBiomassKg,
        densityKgM3: updatedDestTankBatch.densityKgM3,
      };
      await this.operationRepository.save(savedDestOp);
    }

    // Return the batch for GraphQL compatibility
    // Note: The transfer operations are tracked via TankOperation records
    return batch;
  }

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
