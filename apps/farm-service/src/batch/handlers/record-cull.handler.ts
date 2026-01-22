/**
 * RecordCullHandler
 *
 * RecordCullCommand'ı işler ve cull (ayıklama) kaydı oluşturur.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { RecordCullCommand } from '../commands/record-cull.command';
import { Batch } from '../entities/batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';

@Injectable()
@CommandHandler(RecordCullCommand)
export class RecordCullHandler implements ICommandHandler<RecordCullCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: RecordCullCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Tank bul (Equipment entity kullanılıyor)
    const tank = await this.equipmentRepository.findOne({
      where: { id: payload.tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
    }

    // Validasyon
    if (payload.quantity > batch.currentQuantity) {
      throw new BadRequestException(
        `Cull sayısı (${payload.quantity}) mevcut sayıdan (${batch.currentQuantity}) fazla olamaz`
      );
    }

    // Biomass hesapla
    const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // TankBatch bul
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.tankId },
    });

    const preOperationState = tankBatch ? {
      quantity: tankBatch.totalQuantity,
      biomassKg: tankBatch.totalBiomassKg,
      densityKgM3: tankBatch.densityKgM3,
    } : undefined;

    // Tank operation kaydı oluştur
    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.tankId,
      batchId,
      operationType: OperationType.CULL,
      operationDate: payload.culledAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      cullReason: payload.reason as any,
      cullDetail: payload.detail,
      preOperationState,
      performedBy: recordedBy,
      notes: payload.notes,
      isDeleted: false,
    });

    await this.operationRepository.save(operation);

    // Batch güncelle
    batch.cullCount += payload.quantity;
    batch.currentQuantity -= payload.quantity;
    batch.retentionRate = batch.getRetentionRate();
    batch.updatedBy = recordedBy;

    await this.batchRepository.save(batch);

    // TankBatch güncelle
    if (tankBatch) {
      // Ensure numeric operations (database may return decimal columns as strings)
      tankBatch.totalQuantity = Number(tankBatch.totalQuantity) - payload.quantity;
      tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) - biomassKg;

      if (tankBatch.totalQuantity > 0) {
        tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
        const effectiveVolume = tank.volume;
        tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
      }

      await this.tankBatchRepository.save(tankBatch);
    }

    // Tank biomass güncelle
    tank.currentBiomass = Number(tank.currentBiomass || 0) - biomassKg;
    tank.currentCount = (tank.currentCount || 0) - payload.quantity;
    await this.equipmentRepository.save(tank);

    return batch;
  }
}
