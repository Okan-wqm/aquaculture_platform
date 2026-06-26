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
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { BatchTransferredEvent } from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource, EntityManager } from 'typeorm';

import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
  defaultMobileCommandReceiptsForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import { TankCapacityService } from '../../tank/services/tank-capacity.service';
import { TransferBatchCommand } from '../commands/transfer-batch.command';
import { Batch } from '../entities/batch.entity';
import { TankAllocation, AllocationType } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { findTankOrEquipmentWithManager, resolveTankSiteId } from '../utils/tank-lookup.util';

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
    private readonly tankCapacityService: TankCapacityService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    private readonly farmStockProjection: FarmStockProjectionService =
      defaultFarmStockProjectionForDirectHandlerConstruction(),
    private readonly mobileCommandReceipts: MobileCommandReceiptService =
      defaultMobileCommandReceiptsForDirectHandlerConstruction(),
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
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'transferBatch',
        responseType: 'Batch',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(Batch, {
              where: { id: receipt.responseId, tenantId, isActive: true },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      // FARM-HIGH-052: transfer is stock-mutating, so it must carry an idempotency
      // envelope (clientCommandId + payloadHash). 'legacy' (no-key) retries would
      // double-move stock; we REJECT it for parity with mortality/cull. The
      // GraphQL input + REST controller now make the envelope mandatory.
      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'transferBatch requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

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

      // SEC-HIGH-051: object-level site authorization for BOTH legs. A transfer
      // touches the source AND destination site; asserting only one leaves a
      // cross-site escape (move stock OUT of an unassigned site into an assigned
      // one). Resolve each tank's site inside this transaction and assert each.
      // A legitimate cross-site transfer is therefore restricted to
      // MODULE_MANAGER+ (the canonical bypass) — managers own cross-site moves.
      const siteCaller = {
        sub: transferredBy,
        roles: command.userRoles,
        assignedSiteIds: command.callerAssignedSiteIds,
      };
      const sourceSiteId = await resolveTankSiteId(queryRunner.manager, payload.sourceTankId, tenantId);
      this.siteAuth.assertSiteAssignment({ caller: siteCaller, siteId: sourceSiteId });
      const destSiteId = await resolveTankSiteId(queryRunner.manager, payload.destinationTankId, tenantId);
      this.siteAuth.assertSiteAssignment({ caller: siteCaller, siteId: destSiteId });

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

      // LIFE-SAFETY: destination tank capacity check.
      // Centralised in TankCapacityService — the status/biomass/density
      // invariant is enforced from a single implementation across
      // allocate / transfer / deploy. Hard mode: transferring into a
      // stocked tank must not breach welfare limits, period (no admin
      // override path on transfer because the caller has an obvious
      // alternative: split the transfer or use the GRADING/HARVEST
      // flow). skipCapacityCheck is honoured for the pre-existing
      // escape hatch used by internal reconciliation jobs.
      if (!payload.skipCapacityCheck) {
        const destTankBatch = await queryRunner.manager.findOne(TankBatch, {
          where: { tenantId, tankId: payload.destinationTankId },
        });
        this.tankCapacityService.enforce({
          mode: 'hard',
          equipment: destinationTank,
          existing: {
            salmonBiomassKg: Number(destinationTank.currentBiomass || 0),
            cleanerBiomassKg: Number(destTankBatch?.cleanerFishBiomassKg || 0),
          },
          incomingBiomassKg: biomassKg,
        });
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
        const shouldActivate =
          destOriginalTank.status === TankStatus.PREPARING ||
          destOriginalTank.status === TankStatus.FALLOW;
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

      await this.farmStockProjection.refreshContainers(
        queryRunner.manager,
        tenantId,
        [payload.sourceTankId, payload.destinationTankId],
      );

      // Enqueue BatchTransferredEvent into the transactional outbox BEFORE commit.
      // Event field names match the contract exactly: `transferDate` is set
      // (was previously missing), `transferReason` is mapped to the contract's
      // optional `reason` field. `biomassKg` uses the actual computed value,
      // not the pre-update batch state.
      const transferEvent: BatchTransferredEvent = {
        ...createBaseEvent<BatchTransferredEvent>('BatchTransferred', tenantId, { aggregateId: batchId, aggregateType: 'Batch' }),
        userId: transferredBy,
        batchId,
        sourceTankId: payload.sourceTankId,
        destinationTankId: payload.destinationTankId,
        quantity: payload.quantity,
        biomassKg,
        transferDate: toEventIso(transferDate),
        reason: payload.transferReason,
      };
      await this.outboxPublisher.enqueue(transferEvent, queryRunner.manager);
      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'Batch',
        responseId: batch.id,
        responsePayload: { id: batch.id },
      });

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

    // Scope by tenantId on every lookup — `tankId` arrived from a
    // tenant-scoped caller but the discipline is that every findOne
    // carries its tenant filter so a future caller refactor can't
    // silently strip the isolation boundary.
    const equipment = await manager.findOne(Equipment, {
      where: { id: tankId, tenantId },
    });
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

      // Post-update capacity flags — read from the same single source of
      // truth (TankCapacityService) that gates the destination check at
      // line 159. Earlier pass-through here recomputed isOverCapacity
      // from a density-only formula with a hardcoded 30 kg/m³ default,
      // which (a) ignored maxBiomass entirely and (b) produced a
      // different answer than enforce() at the source side. calculate()
      // is the no-throw variant and returns every axis the destination
      // path also enforces.
      if (equipment) {
        const cleanerKg = Number(tankBatch.cleanerFishBiomassKg ?? 0);
        const totalKg = Number(tankBatch.totalBiomassKg ?? 0);
        const capacity = this.tankCapacityService.calculate({
          equipment,
          existing: {
            salmonBiomassKg: Math.max(0, totalKg - cleanerKg),
            cleanerBiomassKg: cleanerKg,
          },
          incomingBiomassKg: 0,
        });
        tankBatch.isOverCapacity = capacity.isOverCapacity;
        tankBatch.capacityUsedPercent = capacity.utilizationPercent;
      }
    }

    if (tankBatch) {
      await manager.save(TankBatch, tankBatch);
    }
  }

}
