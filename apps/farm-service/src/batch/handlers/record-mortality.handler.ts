/**
 * RecordMortalityHandler
 *
 * RecordMortalityCommand'ı işler ve mortality kaydı oluşturur.
 * Batch metriklerini (survival rate, retention rate) günceller.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { RecordMortalityCommand } from '../commands/record-mortality.command';
import { Batch } from '../entities/batch.entity';
import { MortalityRecord, MortalityCause } from '../entities/mortality-record.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';

@Injectable()
@CommandHandler(RecordMortalityCommand)
export class RecordMortalityHandler implements ICommandHandler<RecordMortalityCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(MortalityRecord)
    private readonly mortalityRepository: Repository<MortalityRecord>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: RecordMortalityCommand): Promise<Batch> {
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

    // Validasyon: mortality mevcut sayıyı aşamaz
    if (payload.quantity > batch.currentQuantity) {
      throw new BadRequestException(
        `Mortality sayısı (${payload.quantity}) mevcut sayıdan (${batch.currentQuantity}) fazla olamaz`
      );
    }

    // Biomass hesapla
    const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // Mortality record oluştur
    const mortalityRecord = this.mortalityRepository.create({
      tenantId,
      batchId,
      tankId: payload.tankId,
      recordDate: payload.observedAt,
      count: payload.quantity,
      estimatedBiomassLoss: biomassKg,
      cause: payload.reason as MortalityCause,
      causeDetail: payload.detail,
      notes: payload.notes,
      recordedBy,
    });

    const savedMortality = await this.mortalityRepository.save(mortalityRecord);

    // Tank operation kaydı oluştur
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.tankId },
    });

    const preOperationState = tankBatch ? {
      quantity: tankBatch.totalQuantity,
      biomassKg: tankBatch.totalBiomassKg,
      densityKgM3: tankBatch.densityKgM3,
    } : undefined;

    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.tankId,
      batchId,
      operationType: OperationType.MORTALITY,
      operationDate: payload.observedAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      mortalityReason: payload.reason as MortalityCause,
      mortalityDetail: payload.detail,
      preOperationState,
      performedBy: recordedBy,
      notes: payload.notes,
      isDeleted: false,
    });

    await this.operationRepository.save(operation);

    // Batch metriklerini güncelle
    batch.totalMortality += payload.quantity;
    batch.currentQuantity -= payload.quantity;
    batch.mortalitySummary.totalMortality = batch.totalMortality;
    batch.mortalitySummary.mortalityRate = batch.getMortalityRate();
    batch.mortalitySummary.lastMortalityAt = payload.observedAt;
    batch.mortalitySummary.mainCause = payload.reason;
    batch.retentionRate = batch.getRetentionRate();
    batch.updatedBy = recordedBy;

    await this.batchRepository.save(batch);

    // TankBatch güncelle
    if (tankBatch) {
      // Ensure numeric operations (database may return decimal columns as strings)
      tankBatch.totalQuantity = Number(tankBatch.totalQuantity) - payload.quantity;
      tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) - biomassKg;
      tankBatch.lastMortalityAt = payload.observedAt;
      // Update current quantity/biomass denormalized fields
      tankBatch.currentQuantity = tankBatch.totalQuantity;
      tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;

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

    // Domain event yayınla
    // await this.eventBus.publish(new MortalityRecordedEvent({
    //   tenantId,
    //   batchId,
    //   batchNumber: batch.batchNumber,
    //   tankId: payload.tankId,
    //   quantity: payload.quantity,
    //   reason: payload.reason,
    //   newMortalityRate: batch.getMortalityRate(),
    //   recordedBy,
    // }));

    // Return the updated batch (GraphQL expects Batch, not MortalityRecord)
    return batch;
  }
}
