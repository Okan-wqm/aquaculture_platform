/**
 * RecordMortalityHandler
 *
 * RecordMortalityCommand'ı işler ve mortality kaydı oluşturur.
 * Batch metriklerini (survival rate, retention rate) günceller.
 *
 * SECURITY FIX: All reads moved inside transaction with pessimistic_write locks
 * to prevent TOCTOU race conditions. Math.max(0, ...) guards added to prevent
 * negative counts/biomass from concurrent operations.
 *
 * Phase A refactor: replaced DomainEventPublisher (post-commit fire-and-forget)
 * with OutboxPublisher (pre-commit transactional). Mortality events now ship
 * with at-least-once delivery guarantee even when NATS is briefly unavailable.
 * Event payload uses `MortalityReasonCode` (UPPERCASE) per the contract — the
 * lowercase command input is normalised via `toMortalityReasonCode` at the
 * event boundary, not at the entity layer.
 *
 * @module Batch/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { MortalityRecordedEvent } from '@platform/event-contracts';
import { RecordMortalityCommand } from '../commands/record-mortality.command';
import { Batch } from '../entities/batch.entity';
import { MortalityRecord, MortalityCause } from '../entities/mortality-record.entity';
import { TankOperation, OperationType, MortalityReason } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { findTankOrEquipmentWithManager, TankLookupResult } from '../utils/tank-lookup.util';
import { toMortalityReasonCode } from '../../common/utils/reason-codecs';

@Injectable()
@CommandHandler(RecordMortalityCommand)
export class RecordMortalityHandler implements ICommandHandler<RecordMortalityCommand, Batch> {
  private readonly logger = new Logger(RecordMortalityHandler.name);

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
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: RecordMortalityCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // All reads and writes inside a single transaction with pessimistic locks
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Declare batch outside try block so it's accessible for event publishing and return
    let batch: Batch;

    try {
      // Batch bul with pessimistic lock (prevents concurrent mortality on same batch)
      const foundBatch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!foundBatch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      batch = foundBatch;

      // Tank bul (checks both equipment and tanks tables) via manager
      const tankLookup = await findTankOrEquipmentWithManager(
        queryRunner.manager,
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
        lock: { mode: 'pessimistic_write' },
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

      // Batch metriklerini güncelle (Math.max to prevent negative values)
      batch.totalMortality += payload.quantity;
      batch.currentQuantity = Math.max(0, batch.currentQuantity - payload.quantity);
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
        // Math.max(0, ...) prevents negative values from concurrent operations
        tankBatch.totalQuantity = Math.max(0, Number(tankBatch.totalQuantity) - payload.quantity);
        tankBatch.totalBiomassKg = Math.max(0, Number(tankBatch.totalBiomassKg) - biomassKg);
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

      // Tank biomass güncelle (update the correct table, Math.max to prevent negatives)
      const newBiomass = Math.max(0, Number(tank.currentBiomass || 0) - biomassKg);
      const newCount = Math.max(0, (tank.currentCount || 0) - payload.quantity);
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

      // Enqueue MortalityRecordedEvent into the transactional outbox BEFORE commit.
      // The outbox INSERT is part of the same transaction as the domain writes —
      // either both commit or neither. OutboxWorkerService publishes to NATS
      // asynchronously with retry + dead-letter on failure.
      const mortalityEvent: MortalityRecordedEvent = {
        eventId: randomUUID(),
        eventType: 'MortalityRecorded',
        timestamp: new Date().toISOString(),
        tenantId,
        version: 1,
        userId: recordedBy,
        aggregateId: batchId,
        aggregateType: 'Batch',
        batchId,
        tankId: payload.tankId,
        quantity: payload.quantity,
        reason: toMortalityReasonCode(payload.reason),
        mortalityDate: payload.observedAt,
        newTotalMortality: batch.totalMortality,
        newMortalityRate: batch.getMortalityRate(),
      };
      await this.outboxPublisher.enqueue(mortalityEvent, queryRunner.manager);

      // Commit transaction (domain writes + outbox row are atomic)
      await queryRunner.commitTransaction();
    } catch (error) {
      // Rollback transaction on any error
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      // Release query runner
      await queryRunner.release();
    }

    // Return the updated batch (GraphQL expects Batch, not MortalityRecord)
    return batch;
  }
}
