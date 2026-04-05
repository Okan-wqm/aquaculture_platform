/**
 * RecordCullHandler
 *
 * RecordCullCommand'ı işler ve cull (ayıklama) kaydı oluşturur.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { RecordCullCommand } from '../commands/record-cull.command';
import { Batch } from '../entities/batch.entity';
import { TankOperation, OperationType, CullReason } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';

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

      // Batch güncelle
      batch.cullCount += payload.quantity;
      batch.currentQuantity -= payload.quantity;
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = recordedBy;

      await queryRunner.manager.save(Batch, batch);

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

        await queryRunner.manager.save(TankBatch, tankBatch);
      }

      // Tank biomass güncelle
      tank.currentBiomass = Number(tank.currentBiomass || 0) - biomassKg;
      tank.currentCount = (tank.currentCount || 0) - payload.quantity;
      await queryRunner.manager.save(Equipment, tank);

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

    return batch;
  }
}
