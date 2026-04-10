/**
 * RecordCullHandler
 *
 * RecordCullCommand'ı işler ve cull (ayıklama) kaydı oluşturur.
 *
 * Phase A (CRITICAL fix): adds CullRecordedEvent publish via the transactional
 * outbox. Previously the handler wrote DB rows successfully but **published
 * zero events**, leaving every cull operation invisible to all downstream
 * consumers (read models, dashboards, AI insights). With the outbox enqueue
 * the cull event is delivered with at-least-once guarantee even when NATS
 * is temporarily unavailable.
 *
 * Math.max(0, ...) guards added to all decrement operations to match the
 * pattern in RecordMortalityHandler — concurrent culls could otherwise
 * push currentQuantity / totalBiomassKg below zero.
 *
 * @module Batch/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { CullRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { RecordCullCommand } from '../commands/record-cull.command';
import { Batch } from '../entities/batch.entity';
import { TankOperation, OperationType, CullReason } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { toCullReasonCode } from '../../common/utils/reason-codecs';

@Injectable()
@CommandHandler(RecordCullCommand)
export class RecordCullHandler implements ICommandHandler<RecordCullCommand, Batch> {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: RecordCullCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // C-FARM-02: All reads moved inside the transaction with pessimistic_write
    // locks to eliminate the TOCTOU race condition. Two concurrent RecordCull
    // calls on the same batch previously both read currentQuantity BEFORE either
    // write, allowing both to pass the quantity check even if the sum exceeds
    // the real available count. The lock serialises them at the database level.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Declared outside try so the saved batch is accessible for return
    let batch: Batch;

    try {
      // Batch bul — pessimistic write lock prevents concurrent races
      const foundBatch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!foundBatch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }
      batch = foundBatch;

      // Tank bul (Equipment entity kullanılıyor) — also locked
      const tank = await queryRunner.manager.findOne(Equipment, {
        where: { id: payload.tankId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tank) {
        throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
      }

      // Validasyon — currentQuantity is now authoritative (read inside TX)
      if (payload.quantity > batch.currentQuantity) {
        throw new BadRequestException(
          `Cull sayısı (${payload.quantity}) mevcut sayıdan (${batch.currentQuantity}) fazla olamaz`
        );
      }

      // Biomass hesapla
      const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
      const biomassKg = (payload.quantity * avgWeightG) / 1000;

      // TankBatch bul (inside TX for consistency)
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
      });

      const preOperationState = tankBatch ? {
        quantity: tankBatch.totalQuantity,
        biomassKg: tankBatch.totalBiomassKg,
        densityKgM3: tankBatch.densityKgM3,
      } : undefined;


      // Tank operation kaydı oluştur
      const operation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: payload.tankId,
        batchId,
        operationType: OperationType.CULL,
        operationDate: payload.culledAt,
        quantity: payload.quantity,
        avgWeightG,
        biomassKg,
        cullReason: payload.reason as CullReason,
        cullDetail: payload.detail,
        preOperationState,
        performedBy: recordedBy,
        notes: payload.notes,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankOperation, operation);

      // Batch güncelle (Math.max guards prevent negative values from concurrent culls)
      batch.cullCount += payload.quantity;
      batch.currentQuantity = Math.max(0, batch.currentQuantity - payload.quantity);
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = recordedBy;

      await queryRunner.manager.save(Batch, batch);

      // TankBatch güncelle (Math.max prevents negative values, denormalized
      // currentQuantity/currentBiomassKg fields kept in sync with totals)
      if (tankBatch) {
        // Ensure numeric operations (database may return decimal columns as strings)
        tankBatch.totalQuantity = Math.max(0, Number(tankBatch.totalQuantity) - payload.quantity);
        tankBatch.totalBiomassKg = Math.max(0, Number(tankBatch.totalBiomassKg) - biomassKg);
        tankBatch.currentQuantity = tankBatch.totalQuantity;
        tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;

        if (tankBatch.totalQuantity > 0) {
          tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
          const effectiveVolume = tank.volume;
          tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
        } else {
          tankBatch.avgWeightG = 0;
          tankBatch.densityKgM3 = 0;
        }

        await queryRunner.manager.save(TankBatch, tankBatch);
      }

      // Tank biomass güncelle (Math.max prevents negatives)
      tank.currentBiomass = Math.max(0, Number(tank.currentBiomass || 0) - biomassKg);
      tank.currentCount = Math.max(0, (tank.currentCount || 0) - payload.quantity);
      await queryRunner.manager.save(Equipment, tank);

      // Enqueue CullRecordedEvent into the transactional outbox BEFORE commit.
      // The outbox row is part of the same transaction as the domain writes —
      // either both commit or neither. OutboxWorkerService publishes to NATS
      // asynchronously with retry + dead-letter on failure.
      const cullEvent: CullRecordedEvent = {
        ...createBaseEvent<CullRecordedEvent>('CullRecorded', tenantId, { aggregateId: batchId, aggregateType: 'Batch' }),
        userId: recordedBy,
        batchId,
        tankId: payload.tankId,
        quantity: payload.quantity,
        reason: toCullReasonCode(payload.reason),
        detail: payload.detail,
        culledAt: payload.culledAt,
        newCullCount: batch.cullCount,
        newCurrentQuantity: batch.currentQuantity,
      };
      await this.outboxPublisher.enqueue(cullEvent, queryRunner.manager);

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

    return batch;
  }
}
