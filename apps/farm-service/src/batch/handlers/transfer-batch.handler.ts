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
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { BatchTransferredEvent } from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { RemovalQuantityPolicyService } from '../services/removal-quantity-policy.service';
import { Repository, DataSource } from 'typeorm';

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
import { TankBatchService } from '../services/tank-batch.service';
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
    private readonly dayPlanRecalc: DayPlanRecalcService,
    private readonly removalQuantityPolicy: RemovalQuantityPolicyService,
    private readonly tankCapacityService: TankCapacityService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    // SSoT tank-composition writer (batchDetails[] + derived aggregates + current*).
    private readonly tankBatchService: TankBatchService,
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
    const transferredBatch = await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
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

      // D-3 miktar çözümü (SSoT): kg verildiyse taşınan biyokütle AYNEN odur —
      // kaynakta kalanın ortalaması kayar, hedefe giren partinin ortalaması
      // taşınan kg/tane oranından türetilir.
      const resolvedRemoval = this.removalQuantityPolicy.resolve({
        count: payload.quantity,
        biomassKg: payload.biomassKg,
        currentQuantity: batchInSource?.quantity ?? sourceTankBatch.totalQuantity,
        currentBiomassKg: Number(batchInSource?.biomassKg ?? sourceTankBatch.totalBiomassKg ?? 0),
        currentAvgWeightG: avgWeightG,
      });
      const biomassKg = resolvedRemoval.biomassKg;

      // LIFE-SAFETY: destination tank capacity check.
      // Centralised in TankCapacityService — the status/biomass/density
      // invariant is enforced from a single implementation across
      // allocate / transfer / deploy. Hard mode: transferring into a
      // stocked tank must not breach welfare limits, period. There is no
      // override path on transfer because the caller has an obvious
      // alternative: split the transfer, or use the GRADING/HARVEST flow.
      //
      // This used to sit behind `if (!payload.skipCapacityCheck)`. That input
      // was a plain Boolean on a mutation any MODULE_USER may call, with no
      // role floor, no reason and no audit row — a life-safety gate anyone
      // could switch off from the public schema. No caller in the repository
      // ever set it true, so the escape hatch its comment claimed to serve did
      // not exist. Removing the field is what makes the bypass unreachable;
      // leaving the check unconditional is only the visible half.
      // Read separately from the pre-state row fetched further down: this one is
      // taken before the transfer writes, and the two must not be collapsed into
      // one variable just because they query the same row.
      const destTankBatchAtCapacityCheck = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.destinationTankId },
      });
      this.tankCapacityService.enforce({
        mode: 'hard',
        equipment: destinationTank,
        existing: {
          salmonBiomassKg: Number(destinationTank.currentBiomass || 0),
          cleanerBiomassKg: Number(destTankBatchAtCapacityCheck?.cleanerFishBiomassKg || 0),
        },
        incomingBiomassKg: biomassKg,
      });

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

      // 5. TankBatch updates via the shared SSoT writer (batchDetails[] is the
      // per-batch SSoT; totalQuantity/biomass/avg/density/current* are derived).
      // Capacity flags are then set from TankCapacityService — the single source
      // of truth for capacity — instead of the prior hand-rolled density formula
      // (hardcoded 30 kg/m³, maxBiomass ignored) that lived in the now-deleted
      // private updateTankBatchWithManager.
      const savedSourceTankBatch = await this.tankBatchService.applyBatchDelta(
        queryRunner.manager,
        tenantId,
        payload.sourceTankId,
        {
          batchId,
          batchNumber: batch.batchNumber,
          quantityDelta: -payload.quantity,
          biomassDelta: -biomassKg,
        },
        { volumeM3: Number(sourceTank.volume) || 0 },
      );
      const sourceCapacity = this.tankCapacityService.calculate({
        equipment: sourceTank,
        existing: {
          salmonBiomassKg: Number(savedSourceTankBatch.totalBiomassKg),
          cleanerBiomassKg: Number(savedSourceTankBatch.cleanerFishBiomassKg || 0),
        },
        incomingBiomassKg: 0,
      });
      savedSourceTankBatch.isOverCapacity = sourceCapacity.isOverCapacity;
      savedSourceTankBatch.capacityUsedPercent = sourceCapacity.utilizationPercent;
      await queryRunner.manager.save(savedSourceTankBatch);

      const savedDestTankBatch = await this.tankBatchService.applyBatchDelta(
        queryRunner.manager,
        tenantId,
        payload.destinationTankId,
        {
          batchId,
          batchNumber: batch.batchNumber,
          quantityDelta: payload.quantity,
          biomassDelta: biomassKg,
        },
        {
          code: destinationTank.code,
          name: destinationTank.name,
          volumeM3: Number(destinationTank.volume) || 0,
        },
      );
      const destCapacity = this.tankCapacityService.calculate({
        equipment: destinationTank,
        existing: {
          salmonBiomassKg: Number(savedDestTankBatch.totalBiomassKg),
          cleanerBiomassKg: Number(savedDestTankBatch.cleanerFishBiomassKg || 0),
        },
        incomingBiomassKg: 0,
      });
      savedDestTankBatch.isOverCapacity = destCapacity.isOverCapacity;
      savedDestTankBatch.capacityUsedPercent = destCapacity.utilizationPercent;
      await queryRunner.manager.save(savedDestTankBatch);

      // 6. Tank/Equipment biomass güncellemeleri (Math.max to prevent negatives).
      // currentCount for BOTH legs is derived + written by
      // TankBatchService.applyBatchDelta (the SINGLE count writer) above — no
      // independent count write here (that drifted from tank_batches, the SSoT).
      // currentBiomass stays on its growth-tracking path; biomass-ONLY UPDATEs
      // (never a full-entity save, which would clobber the derived currentCount).
      // A transfer INTO a PREPARING/FALLOW tank still ACTIVATES it (status-only,
      // folded into the same biomass UPDATE).
      const newSourceBiomass = Math.max(0, Number(sourceTank.currentBiomass || 0) - biomassKg);
      if (sourceLookup.isFromTanksTable && sourceLookup.originalTank) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: newSourceBiomass })
          .where('id = :id', { id: sourceLookup.originalTank.id })
          .execute();
      } else {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Equipment)
          .set({ currentBiomass: newSourceBiomass })
          .where('id = :id', { id: sourceTank.id })
          .execute();
      }

      const newDestBiomass = Number(destinationTank.currentBiomass || 0) + biomassKg;
      if (destLookup.isFromTanksTable && destLookup.originalTank) {
        const destOriginalTank = destLookup.originalTank;
        const shouldActivate =
          destOriginalTank.status === TankStatus.PREPARING ||
          destOriginalTank.status === TankStatus.FALLOW;
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: newDestBiomass, ...(shouldActivate ? { status: TankStatus.ACTIVE } : {}) })
          .where('id = :id', { id: destOriginalTank.id })
          .execute();
      } else {
        const shouldActivate =
          destinationTank.status === EquipmentStatus.PREPARING ||
          destinationTank.status === EquipmentStatus.FALLOW;
        await queryRunner.manager
          .createQueryBuilder()
          .update(Equipment)
          .set({ currentBiomass: newDestBiomass, ...(shouldActivate ? { status: EquipmentStatus.ACTIVE } : {}) })
          .where('id = :id', { id: destinationTank.id })
          .execute();
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

      // P-31: transfer İKİ üniteyi de değiştirir — kaynak küçüldü, hedef büyüdü;
      // her ikisinin bugünkü beslenmemiş öğünleri aynı tx'te yeniden fiyatlanır.
      // (Grading bu komutu compose ettiği için otomatik kapsanır — tier-2.)
      await this.dayPlanRecalc.recalcForUnit(
        queryRunner.manager,
        tenantId,
        payload.sourceTankId,
        'transfer',
      );
      await this.dayPlanRecalc.recalcForUnit(
        queryRunner.manager,
        tenantId,
        payload.destinationTankId,
        'transfer',
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

      // Domain writes + outbox row are atomic — runInTenantTransaction commits.
      return batch;
    });

    // Post-commit side effect: log only after the transaction has committed.
    this.logger.log(
      `Batch ${batchId} transferred: tank ${payload.sourceTankId} → ${payload.destinationTankId}, ` +
      `quantity=${payload.quantity}, tenant=${tenantId}`,
    );

    return transferredBatch;
  }

}
