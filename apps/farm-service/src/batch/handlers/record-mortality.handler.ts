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
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { RecordMortalityCommand } from '../commands/record-mortality.command';
import { Batch } from '../entities/batch.entity';
import { MortalityRecord, MortalityCause } from '../entities/mortality-record.entity';
import { TankOperation, OperationType, MortalityReason } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { findTankOrEquipment, TankLookupResult } from '../utils/tank-lookup.util';

@Injectable()
@CommandHandler(RecordMortalityCommand)
export class RecordMortalityHandler implements ICommandHandler<RecordMortalityCommand, Batch> {
  constructor(
    private readonly dataSource: DataSource,
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
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: RecordMortalityCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // Read operations outside transaction
    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Tank bul (checks both equipment and tanks tables)
    const tankLookup = await findTankOrEquipment(
      this.equipmentRepository,
      this.tankRepository,
      this.equipmentTypeRepository,
      payload.tankId,
      tenantId,
    );

    if (!tankLookup) {
      throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
    }

    const tank = tankLookup.equipment;

    // Validasyon: mortality mevcut sayıyı aşamaz
    if (payload.quantity > batch.currentQuantity) {
      throw new BadRequestException(
        `Mortality sayısı (${payload.quantity}) mevcut sayıdan (${batch.currentQuantity}) fazla olamaz`
      );
    }

    // Biomass hesapla
    const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // Start transaction for all database write operations
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Mortality record oluştur
      const mortalityRecord = queryRunner.manager.create(MortalityRecord, {
        tenantId,
        batchId,
        tankId: payload.tankId,
        recordDate: payload.observedAt,
        count: payload.quantity,
        estimatedBiomassLoss: biomassKg,
        cause: MortalityCause[payload.reason.toUpperCase() as keyof typeof MortalityCause] ?? MortalityCause.UNKNOWN,
        causeDetail: payload.detail,
        notes: payload.notes,
        recordedBy,
      });

      await queryRunner.manager.save(MortalityRecord, mortalityRecord);

      // Tank operation kaydı oluştur
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
      });

      const preOperationState = tankBatch ? {
        quantity: tankBatch.totalQuantity,
        biomassKg: tankBatch.totalBiomassKg,
        densityKgM3: tankBatch.densityKgM3,
      } : undefined;

      const operation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: payload.tankId,
        batchId,
        operationType: OperationType.MORTALITY,
        operationDate: payload.observedAt,
        quantity: payload.quantity,
        avgWeightG,
        biomassKg,
        mortalityReason: MortalityReason[payload.reason.toUpperCase() as keyof typeof MortalityReason] ?? MortalityReason.UNKNOWN,
        mortalityDetail: payload.detail,
        preOperationState,
        performedBy: recordedBy,
        notes: payload.notes,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankOperation, operation);

      // Batch metriklerini güncelle
      batch.totalMortality += payload.quantity;
      batch.currentQuantity -= payload.quantity;
      batch.mortalitySummary.totalMortality = batch.totalMortality;
      batch.mortalitySummary.mortalityRate = batch.getMortalityRate();
      batch.mortalitySummary.lastMortalityAt = payload.observedAt;
      batch.mortalitySummary.mainCause = payload.reason;
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = recordedBy;

      await queryRunner.manager.save(Batch, batch);

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

        await queryRunner.manager.save(TankBatch, tankBatch);
      }

      // Tank biomass güncelle (update the correct table)
      const newBiomass = Number(tank.currentBiomass || 0) - biomassKg;
      const newCount = (tank.currentCount || 0) - payload.quantity;
      if (tankLookup.isFromTanksTable && tankLookup.originalTank) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: newBiomass, currentCount: newCount })
          .where('id = :id', { id: tankLookup.originalTank.id })
          .execute();
      } else {
        tank.currentBiomass = newBiomass;
        tank.currentCount = newCount;
        await queryRunner.manager.save(Equipment, tank);
      }

      // Commit transaction
      await queryRunner.commitTransaction();
    } catch (error) {
      // Rollback transaction on any error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // Release query runner
      await queryRunner.release();
    }

    // Publish domain event (after commit, outside transaction)
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          eventId: crypto.randomUUID(),
          eventType: 'MortalityRecorded',
          timestamp: new Date(),
          tenantId,
          batchId,
          tankId: payload.tankId,
          quantity: payload.quantity,
          reason: payload.reason,
          mortalityDate: payload.observedAt,
          newTotalMortality: batch.totalMortality,
          newMortalityRate: batch.getMortalityRate(),
          userId: recordedBy,
          version: 1,
        });
      } catch (eventError) {
        // Log but don't fail for event publishing errors
      }
    }

    // Return the updated batch (GraphQL expects Batch, not MortalityRecord)
    return batch;
  }
}
