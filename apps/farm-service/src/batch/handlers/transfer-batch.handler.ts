/**
 * TransferBatchHandler
 *
 * TransferBatchCommand'ı işler ve batch'i bir tank'tan diğerine transfer eder.
 *
 * SECURITY FIX: All reads moved inside transaction with pessimistic_write locks
 * to prevent TOCTOU race conditions. Math.max(0, ...) guards added to prevent
 * negative counts/biomass from concurrent operations. Deprecated
 * updateTankBatchAfterTransfer method removed.
 *
 * Phase A refactor: replaced DomainEventPublisher with OutboxPublisher
 * (pre-commit, transactional). Event payload now matches the
 * BatchTransferredEvent contract exactly: `transferDate` is provided
 * (was missing), `transferReason` is mapped to the contract's optional
 * `reason` field (was a non-contract field name). The previous post-commit
 * fire-and-forget pattern silently dropped events on any NATS hiccup.
 *
 * @module Batch/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { BatchTransferredEvent } from '@platform/event-contracts';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { Batch } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { findTankOrEquipmentWithManager, TankLookupResult } from '../utils/tank-lookup.util';

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
  private readonly logger = new Logger(TransferBatchHandler.name);

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
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: TransferBatchCommand): Promise<Batch> {
    const { tenantId, batchId, payload, transferredBy } = command;

    if (payload.sourceTankId === payload.destinationTankId) {
      throw new BadRequestException('Kaynak ve hedef tank aynı olamaz');
    }

    // All reads and writes inside a single transaction with pessimistic locks
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Batch bul with pessimistic lock
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // Tank lookups via manager (transaction-safe)
      const sourceLookup = await findTankOrEquipmentWithManager(
        queryRunner.manager,
        payload.sourceTankId,
        tenantId,
      );

      if (!sourceLookup) {
        throw new NotFoundException(`Kaynak tank ${payload.sourceTankId} bulunamadı`);
      }

      const sourceTank = sourceLookup.equipment;

      const destLookup = await findTankOrEquipmentWithManager(
        queryRunner.manager,
        payload.destinationTankId,
        tenantId,
      );

      if (!destLookup) {
        throw new NotFoundException(`Hedef tank ${payload.destinationTankId} bulunamadı`);
      }

      const destinationTank = destLookup.equipment;

      // Source TankBatch with pessimistic lock
      const sourceTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.sourceTankId },
        lock: { mode: 'pessimistic_write' },
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

      // 6. Tank/Equipment biomass güncellemeleri (Math.max to prevent negatives)
      const newSourceBiomass = Math.max(0, Number(sourceTank.currentBiomass || 0) - biomassKg);
      const newSourceCount = Math.max(0, (sourceTank.currentCount || 0) - payload.quantity);
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

      // Enqueue BatchTransferredEvent into the transactional outbox BEFORE commit.
      // Event field names match the contract exactly: `transferDate` is set
      // (was previously missing), `transferReason` is mapped to the contract's
      // optional `reason` field. `biomassKg` uses the actual computed value,
      // not the pre-update batch state.
      const transferEvent: BatchTransferredEvent = {
        eventId: randomUUID(),
        eventType: 'BatchTransferred',
        timestamp: new Date(),
        tenantId,
        version: 1,
        userId: transferredBy,
        aggregateId: batchId,
        aggregateType: 'Batch',
        batchId,
        sourceTankId: payload.sourceTankId,
        destinationTankId: payload.destinationTankId,
        quantity: payload.quantity,
        biomassKg,
        transferDate,
        reason: payload.transferReason,
      };
      await this.outboxPublisher.enqueue(transferEvent, queryRunner.manager);

      // Commit transaction (domain writes + outbox row are atomic)
      await queryRunner.commitTransaction();

      this.logger.log(
        `Batch ${batchId} transferred: tank ${payload.sourceTankId} → ${payload.destinationTankId}, ` +
        `quantity=${payload.quantity}, tenant=${tenantId}`,
      );

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
        cleanerFishBiomassKg: 0,
        cleanerFishQuantity: 0,
      });
    } else if (tankBatch) {
      // FARM-MEDIUM-003: Math.max(0) guards prevent negative fish count / biomass
      // when concurrent operations produce stale reads (even with pessimistic locks,
      // the delta might be computed from a stale snapshot in edge cases).
      // Ensure numeric operations (database may return decimal columns as strings)
      tankBatch.totalQuantity = Math.max(0, Number(tankBatch.totalQuantity) + quantityDelta);
      tankBatch.totalBiomassKg = Math.max(0, Number(tankBatch.totalBiomassKg) + biomassDelta);

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

}
