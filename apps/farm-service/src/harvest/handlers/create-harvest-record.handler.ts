/**
 * CreateHarvestRecordHandler
 *
 * CreateHarvestRecordCommand'ı işler ve harvest kaydı oluşturur.
 * Tank ve Batch'i günceller.
 *
 * SECURITY FIX: All reads moved inside transaction with pessimistic_write locks
 * to prevent TOCTOU race conditions. generateCode() moved inside transaction.
 * Math.max(0, ...) guards added to prevent negative biomass values.
 *
 * Phase A refactor: replaced DomainEventPublisher (post-commit fire-and-forget,
 * publishing non-contract field names) with OutboxPublisher (pre-commit
 * transactional). The previous event payload sent `harvestRecordId`,
 * `lotNumber`, `totalQuantity`, `totalBiomassKg` — none of which exist on the
 * BatchHarvestedEvent contract. The contract requires `harvestedQuantity`,
 * `harvestedAt`, `averageWeight`, `totalWeight`. The wrong field names made
 * downstream consumers (read models, dashboards) read `undefined` for the
 * critical harvest-quantity field, silently producing zero rows in projections.
 *
 * @module Harvest/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import type { BatchHarvestedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateHarvestRecordCommand, CreateHarvestRecordInput } from '../commands/create-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus, QualityGrade, HarvestOperation, LotInfo } from '../entities/harvest-record.entity';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { Tank } from '../../tank/entities/tank.entity';

@Injectable()
@CommandHandler(CreateHarvestRecordCommand)
// Return HarvestRecord so the GraphQL resolver can expose harvest-specific fields to clients
export class CreateHarvestRecordHandler implements ICommandHandler<CreateHarvestRecordCommand, HarvestRecord> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
  ) {}

  async execute(command: CreateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, input, recordedBy } = command;

    // Parse harvestDate early (no DB needed)
    const harvestDate = typeof input.harvestDate === 'string'
      ? new Date(input.harvestDate)
      : input.harvestDate;

    // Parse qualityGrade early (no DB needed)
    const qualityGrade = this.parseQualityGrade(input.qualityGrade);

    // All reads and writes inside a single transaction with pessimistic locks
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Batch bul with pessimistic lock
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: input.batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
      }

      // Tank bul with pessimistic lock
      const tank = await queryRunner.manager.findOne(Tank, {
        where: { id: input.tankId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tank) {
        throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
      }

      if (input.quantityHarvested > batch.currentQuantity) {
        throw new BadRequestException(
          `Harvest miktarı (${input.quantityHarvested}) batch'in mevcut miktarından (${batch.currentQuantity}) fazla olamaz`
        );
      }

      // TankBatch with pessimistic lock
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: input.tankId },
        lock: { mode: 'pessimistic_write' },
      });

      if (tankBatch && input.quantityHarvested > tankBatch.totalQuantity) {
        throw new BadRequestException(
          `Harvest miktarı (${input.quantityHarvested}) tank'taki miktardan (${tankBatch.totalQuantity}) fazla olamaz`
        );
      }

      // Biomass hesapla
      const biomassKg = input.totalBiomass || (input.quantityHarvested * input.averageWeight) / 1000;

      // Record code ve lot number oluştur — pass queryRunner.manager so the
      // pessimistic_read lock runs inside this transaction, preventing concurrent
      // inserts from allocating the same sequence (duplicate lot number = regulatory violation).
      const recordCode = await this.generateCode(tenantId, 'HR', queryRunner.manager);
      const lotNumber = await this.generateCode(tenantId, 'LOT', queryRunner.manager);

      // Operation detaylarını oluştur
      const operation: HarvestOperation = {
        startTime: harvestDate,
        method: HarvestMethod.NET,
      };

      // Lot bilgilerini oluştur
      const lotInfo: LotInfo = {
        lotNumber,
        productionDate: harvestDate,
      };

      // Pre-operation state kaydet
      const preOperationState = tankBatch ? {
        quantity: tankBatch.totalQuantity,
        biomassKg: tankBatch.totalBiomassKg,
        densityKgM3: tankBatch.densityKgM3,
      } : undefined;

      // HarvestRecord oluştur
      const harvestRecord = queryRunner.manager.create(HarvestRecord, {
        tenantId,
        recordCode,
        lotNumber,
        batchId: input.batchId,
        tankId: input.tankId,
        status: HarvestRecordStatus.COMPLETED,
        harvestDate,
        operation,
        method: HarvestMethod.NET,
        quantityHarvested: input.quantityHarvested,
        totalBiomass: biomassKg,
        averageWeight: input.averageWeight,
        productForm: ProductForm.FRESH_WHOLE,
        qualityGrade,
        lotInfo,
        supervisorId: recordedBy,
        notes: input.notes,
        totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined,
        currency: input.pricePerKg ? 'TRY' : undefined,
      });

      // Customer delivery bilgisi ekle
      if (input.buyerName) {
        harvestRecord.customerDeliveries = [{
          customerId: 'direct-buyer',
          customerName: input.buyerName,
          quantity: biomassKg,
          quantityUnit: 'kg',
          unitPrice: input.pricePerKg || 0,
          totalValue: input.pricePerKg ? biomassKg * input.pricePerKg : 0,
          currency: 'TRY',
          deliveryStatus: 'pending',
        }];
      }

      await queryRunner.manager.save(HarvestRecord, harvestRecord);

      // TankOperation kaydı oluştur
      const tankOperation = queryRunner.manager.create(TankOperation, {
        tenantId,
        tankId: input.tankId,
        batchId: input.batchId,
        operationType: OperationType.HARVEST,
        operationDate: harvestDate,
        quantity: input.quantityHarvested,
        avgWeightG: input.averageWeight,
        biomassKg,
        preOperationState,
        performedBy: recordedBy,
        notes: input.notes,
        isDeleted: false,
      });

      await queryRunner.manager.save(TankOperation, tankOperation);

      // Batch güncelle (Math.max to prevent negative values)
      batch.currentQuantity = Math.max(0, batch.currentQuantity - input.quantityHarvested);
      batch.harvestedQuantity = (batch.harvestedQuantity || 0) + input.quantityHarvested;
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = recordedBy;

      // Tüm stok hasad edildiyse batch'i HARVESTED olarak işaretle
      if (batch.currentQuantity <= 0) {
        batch.status = BatchStatus.HARVESTED;
        batch.statusChangedAt = new Date();
        batch.actualHarvestDate = new Date();
      }

      await queryRunner.manager.save(Batch, batch);

      // TankBatch güncelle (Math.max to prevent negatives from concurrent operations)
      if (tankBatch) {
        // Ensure numeric operations (decimal columns may come as strings)
        tankBatch.totalQuantity = Math.max(0, Number(tankBatch.totalQuantity) - input.quantityHarvested);
        tankBatch.totalBiomassKg = Math.max(0, Number(tankBatch.totalBiomassKg) - biomassKg);
        tankBatch.currentQuantity = tankBatch.totalQuantity;
        tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;

        if (tankBatch.totalQuantity > 0) {
          tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
          const effectiveVolume = tank.waterVolume || tank.volume;
          tankBatch.densityKgM3 = effectiveVolume ? Number(tankBatch.totalBiomassKg) / Number(effectiveVolume) : 0;
        } else {
          tankBatch.avgWeightG = 0;
          tankBatch.densityKgM3 = 0;
        }

        await queryRunner.manager.save(TankBatch, tankBatch);
      }

      // Tank güncelle (Math.max to prevent negatives)
      tank.currentBiomass = Math.max(0, Number(tank.currentBiomass || 0) - biomassKg);
      tank.currentCount = Math.max(0, (tank.currentCount || 0) - input.quantityHarvested);
      await queryRunner.manager.save(Tank, tank);

      // Post-operation state güncelle
      const updatedTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: input.tankId },
      });

      if (updatedTankBatch) {
        tankOperation.postOperationState = {
          quantity: updatedTankBatch.totalQuantity,
          biomassKg: updatedTankBatch.totalBiomassKg,
          densityKgM3: updatedTankBatch.densityKgM3,
        };
        await queryRunner.manager.save(TankOperation, tankOperation);
      }

      // Enqueue BatchHarvestedEvent into the transactional outbox BEFORE commit.
      // Field names match the BatchHarvestedEvent contract exactly:
      // `harvestedQuantity`, `harvestedAt`, `averageWeight`, `totalWeight`.
      // The previous implementation sent `harvestRecordId`/`lotNumber`/
      // `totalQuantity`/`totalBiomassKg` — none of those are contract fields,
      // so consumers reading `event.harvestedQuantity` got `undefined`.
      const harvestEvent: BatchHarvestedEvent = {
        eventId: randomUUID(),
        eventType: 'BatchHarvested',
        timestamp: new Date().toISOString(),
        tenantId,
        version: 1,
        userId: recordedBy,
        aggregateId: harvestRecord.batchId,
        aggregateType: 'Batch',
        batchId: harvestRecord.batchId,
        harvestedQuantity: harvestRecord.quantityHarvested,
        harvestedAt: harvestRecord.harvestDate,
        averageWeight: harvestRecord.averageWeight,
        totalWeight: harvestRecord.totalBiomass,
      };
      await this.outboxPublisher.enqueue(harvestEvent, queryRunner.manager);

      // Commit transaction (domain writes + outbox row are atomic)
      await queryRunner.commitTransaction();

      // Return the created harvest record so clients get harvest-specific fields
      return harvestRecord;
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
   * Code oluşturma (HR-2024-00001 veya LOT-2024-00001 formatında)
   */
  /**
   * Generate unique sequential code inside an existing transaction.
   *
   * @param manager - QueryRunner's EntityManager (must be inside an open TX with
   *   pessimistic_read or pessimistic_write lock on the table to prevent duplicate
   *   sequence allocation under concurrent inserts).
   */
  private async generateCode(
    tenantId: string,
    prefix: string,
    manager: import('typeorm').EntityManager,
  ): Promise<string> {
    const year = new Date().getFullYear();

    // Use the transaction-scoped manager + setLock to prevent concurrent requests
    // from reading the same last-sequence value and producing duplicate lot/record codes.
    // Regulatory compliance: duplicate lot numbers break product recall traceability.
    const lastRecord = await manager
      .createQueryBuilder(HarvestRecord, 'hr')
      .where('hr.tenantId = :tenantId', { tenantId })
      .andWhere(prefix === 'HR' ? 'hr.recordCode LIKE :pattern' : 'hr.lotNumber LIKE :pattern', {
        pattern: `${prefix}-${year}-%`
      })
      .orderBy(prefix === 'HR' ? 'hr.recordCode' : 'hr.lotNumber', 'DESC')
      .setLock('pessimistic_read')
      .getOne();

    let sequence = 1;
    if (lastRecord) {
      const codeField = prefix === 'HR' ? lastRecord.recordCode : lastRecord.lotNumber;
      const match = codeField.match(new RegExp(`${prefix}-${year}-(\\d+)`));
      if (match && match[1]) {
        sequence = parseInt(match[1], 10) + 1;
      }
    }

    return `${prefix}-${year}-${sequence.toString().padStart(5, '0')}`;
  }

  /**
   * QualityGrade parse et
   */
  private parseQualityGrade(grade: string | QualityGrade): QualityGrade {
    const gradeMap: Record<string, QualityGrade> = {
      'PREMIUM': QualityGrade.PREMIUM,
      'premium': QualityGrade.PREMIUM,
      'GRADE_A': QualityGrade.GRADE_A,
      'grade_a': QualityGrade.GRADE_A,
      'GRADE_B': QualityGrade.GRADE_B,
      'grade_b': QualityGrade.GRADE_B,
      'GRADE_C': QualityGrade.GRADE_C,
      'grade_c': QualityGrade.GRADE_C,
      'REJECT': QualityGrade.REJECT,
      'reject': QualityGrade.REJECT,
    };

    return gradeMap[grade] || QualityGrade.GRADE_A;
  }
}
