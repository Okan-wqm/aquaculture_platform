/**
 * HarvestRecordWriter — the single owner of "harvest N fish of batch B out of
 * tank T".
 *
 * WHY: a harvest is written from two entry points — a direct harvest record
 * (CreateHarvestRecordHandler) and the completion of a harvest plan
 * (CompleteHarvestPlanHandler), which harvests the batch out of every tank
 * holding it. When the plan path re-dispatched the direct-harvest COMMAND per
 * tank, each tank ran in its own transaction: a failure on tank 2 left tank 1
 * harvested with the plan still IN_PROGRESS, and a retry harvested tank 1
 * again (FARM-HIGH-394). The write itself now lives here and takes the
 * caller's EntityManager, so the caller's ONE transaction spans every tank
 * and the plan row.
 *
 * WHAT: {@link write} runs the compliance gates (withdrawal period, harvest
 * plan policy, object-level site authorization), locks batch → tank →
 * tank-batch in that order (the order every stock-removal path uses), writes
 * the HarvestRecord + TankOperation ledger rows, decrements the batch and the
 * tank composition through the TankBatchService SSoT writer and enqueues the
 * BatchHarvested event into the transactional outbox. It never commits:
 * the caller's transaction boundary does. {@link closeBatchAfterFinalHarvest}
 * is the post-commit batch-closure chain both callers run once their
 * transaction has committed.
 *
 * @module Harvest/Services
 */
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CommandBus } from '@platform/cqrs';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import type { BatchHarvestedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import { BatchCloseReason, CloseBatchCommand } from '../../batch/commands/close-batch.command';
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { OperationType, TankOperation } from '../../batch/entities/tank-operation.entity';
import { TankBatchService } from '../../batch/services/tank-batch.service';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import { BatchWithdrawalBlockedError } from '../../common/errors/farm-errors';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';
import { Tank } from '../../tank/entities/tank.entity';
import type { CreateHarvestRecordInput } from '../commands/create-harvest-record.command';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';
import {
  HarvestOperation,
  HarvestRecord,
  HarvestRecordStatus,
  LotInfo,
} from '../entities/harvest-record.entity';
import { HarvestPolicyService } from './harvest-policy.service';

/** One tank's harvest, as the writer receives it from either entry point. */
export interface HarvestRecordWrite {
  tenantId: string;
  input: CreateHarvestRecordInput;
  /** Parsed harvest date; the caller has already applied the backdate policy. */
  harvestDate: Date;
  /** The verified caller: `sub` is the recorder, roles + sites feed the site check. */
  caller: SiteScopeCaller;
  /** Tenant default currency (FARM-HIGH-151), resolved before the transaction. */
  defaultCurrency: string;
}

export interface HarvestRecordWriteResult {
  harvestRecord: HarvestRecord;
  /** The batch reached zero with this write (single source for BatchHarvested.isFinal). */
  isFinalHarvest: boolean;
  recordCode: string;
}

@Injectable()
export class HarvestRecordWriter {
  private readonly logger = new Logger(HarvestRecordWriter.name);

  constructor(
    private readonly outboxPublisher: OutboxPublisher,
    private readonly dayPlanRecalc: DayPlanRecalcService,
    private readonly commandBus: CommandBus,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
    private readonly harvestPolicy: HarvestPolicyService,
    // Single SSoT writer for tank composition — harvest decrements the tank's
    // batchDetails[] through this, never by hand (see the applyBatchDelta call).
    private readonly tankBatchService: TankBatchService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    private readonly farmStockProjection: FarmStockProjectionService,
    @Optional()
    private readonly metricsService?: FarmDomainMetricsService,
  ) {}

  /**
   * Harvest one tank inside the caller's open tenant transaction. Every read
   * takes its lock through `manager`, so the caller's transaction serialises
   * this write against every other stock mutation of the same batch and tank.
   */
  async write(
    manager: EntityManager,
    request: HarvestRecordWrite,
  ): Promise<HarvestRecordWriteResult> {
    const { tenantId, input, harvestDate, caller, defaultCurrency } = request;
    const recordedBy = caller.sub;

    // Batch with pessimistic lock — first in the batch → tank → tank-batch order.
    const batch = await manager.findOne(Batch, {
      where: { id: input.batchId, tenantId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!batch) {
      throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
    }

    // ── COMPLIANCE GATE: medicine withdrawal period ─────────────────────
    //
    // Food-safety rule (Norwegian Mattilsynet, EU Reg 37/2010): harvesting a
    // batch before the medicine withdrawal period has elapsed puts unsafe fish
    // on the market. The check reads a separate table, so it cannot deadlock
    // on the batch row lock; it runs while the caller's transaction holds that
    // lock, so a concurrent resolveHealthEvent cannot clear the block between
    // the check and the harvest write. Blocking logic lives in
    // BatchHarvestEligibilityService so the `batchHarvestEligibility` query
    // reuses it for UI pre-submit warnings.
    const eligibility = await this.harvestEligibility.checkEligibility(
      tenantId,
      input.batchId,
      harvestDate,
    );
    if (!eligibility.eligible) {
      this.metricsService?.incWithdrawalBlock({ tenantId, surface: 'harvest_record' });
      throw new BatchWithdrawalBlockedError({
        userMessage: eligibility.reason ?? 'Harvest blocked by active medicine withdrawal period.',
        activeTreatments: eligibility.blockingEvents.map((e) => ({
          eventCode: e.id,
          productName: e.title,
          earliestHarvestDate: e.earliestHarvestDate.toISOString(),
          daysRemaining: Math.max(
            0,
            Math.ceil((e.earliestHarvestDate.getTime() - Date.now()) / 86_400_000),
          ),
        })),
        fieldPath: ['createHarvestRecord', 'batchId'],
      });
    }

    // ── POLICY GATE: harvest-plan mandatory for large harvests ──────
    //
    // Large harvests (over the biomass or quantity threshold — env
    // overridable) MUST cite an APPROVED / SCHEDULED / IN_PROGRESS harvest
    // plan for the same batch. See HarvestPolicyService.
    await this.harvestPolicy.evaluate({
      tenantId,
      batchId: input.batchId,
      projectedBiomassKg: Number(input.totalBiomass || 0),
      projectedQuantity: Number(input.quantityHarvested || 0),
      harvestPlanId: input.harvestPlanId ?? null,
    });

    // Tank with pessimistic lock
    const tank = await manager.findOne(Tank, {
      where: { id: input.tankId, tenantId, isActive: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tank) {
      throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
    }

    // SEC-HIGH-051: object-level site authorization. Resolve the tank's owning
    // site inside the transaction and assert the caller is assigned to it
    // BEFORE any harvest write. MODULE_MANAGER+ bypasses; a site-less /
    // unresolved tank is DENIED.
    const tankSiteId = await resolveTankSiteId(manager, input.tankId, tenantId);
    this.siteAuth.assertSiteAssignment({ caller, siteId: tankSiteId });

    if (input.quantityHarvested > batch.currentQuantity) {
      throw new BadRequestException(
        `Harvest miktarı (${input.quantityHarvested}) batch'in mevcut miktarından (${batch.currentQuantity}) fazla olamaz`,
      );
    }

    // TankBatch with pessimistic lock
    const tankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId: input.tankId },
      lock: { mode: 'pessimistic_write' },
    });
    if (tankBatch && input.quantityHarvested > tankBatch.totalQuantity) {
      throw new BadRequestException(
        `Harvest miktarı (${input.quantityHarvested}) tank'taki miktardan (${tankBatch.totalQuantity}) fazla olamaz`,
      );
    }

    const biomassKg = input.totalBiomass || (input.quantityHarvested * input.averageWeight) / 1000;

    // Record code + lot number through the transaction's manager so the
    // pessimistic_read lock runs inside it: concurrent inserts cannot allocate
    // the same sequence (duplicate lot number = regulatory violation), and a
    // second tank in the same transaction sees the first tank's codes.
    const recordCode = await this.generateCode(tenantId, 'HR', manager);
    const lotNumber = await this.generateCode(tenantId, 'LOT', manager);

    const operation: HarvestOperation = { startTime: harvestDate, method: HarvestMethod.NET };
    const lotInfo: LotInfo = { lotNumber, productionDate: harvestDate };
    const preOperationState = tankBatch
      ? {
          quantity: tankBatch.totalQuantity,
          biomassKg: tankBatch.totalBiomassKg,
          densityKgM3: tankBatch.densityKgM3,
        }
      : undefined;

    const harvestRecord = manager.create(HarvestRecord, {
      tenantId,
      recordCode,
      lotNumber,
      batchId: input.batchId,
      tankId: input.tankId,
      harvestPlanId: input.harvestPlanId,
      status: HarvestRecordStatus.COMPLETED,
      harvestDate,
      operation,
      method: HarvestMethod.NET,
      quantityHarvested: input.quantityHarvested,
      totalBiomass: biomassKg,
      averageWeight: input.averageWeight,
      productForm: ProductForm.FRESH_WHOLE,
      // Official Norwegian quality class is the sole stored quality taxonomy
      // (RPT-007), always the caller's own input. qualityGrade is a read-only
      // derived alias — not stored.
      qualityClass: input.qualityClass,
      lotInfo,
      supervisorId: recordedBy,
      notes: input.notes,
      totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined,
      currency: input.pricePerKg ? defaultCurrency : undefined,
    });

    // A customer delivery exists only when the caller named a buyer.
    if (input.buyerName) {
      harvestRecord.customerDeliveries = [
        {
          customerId: 'direct-buyer',
          customerName: input.buyerName,
          quantity: biomassKg,
          quantityUnit: 'kg',
          unitPrice: input.pricePerKg || 0,
          totalValue: input.pricePerKg ? biomassKg * input.pricePerKg : 0,
          currency: defaultCurrency,
          deliveryStatus: 'pending',
        },
      ];
    }

    await manager.save(HarvestRecord, harvestRecord);

    const tankOperation = manager.create(TankOperation, {
      tenantId,
      tankId: input.tankId,
      batchId: input.batchId,
      // The link a cancellation withdraws this row by (FARM-HIGH-198).
      // Written in the same transaction as the record it mirrors, so a
      // ledger row can never exist without a way to name its harvest.
      harvestRecordId: harvestRecord.id,
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
    await manager.save(TankOperation, tankOperation);

    batch.currentQuantity = Math.max(0, batch.currentQuantity - input.quantityHarvested);
    batch.harvestedQuantity = (batch.harvestedQuantity || 0) + input.quantityHarvested;
    batch.retentionRate = batch.getRetentionRate();
    batch.updatedBy = recordedBy;

    // Single source for the BatchHarvested.isFinal signal (FARM-LOW-004): the
    // SAME post-decrement value gates the HARVESTED status AND the event field.
    const isFinalHarvest = batch.currentQuantity <= 0;
    if (isFinalHarvest) {
      batch.status = BatchStatus.HARVESTED;
      batch.statusChangedAt = new Date();
      batch.actualHarvestDate = new Date();
    }
    await manager.save(Batch, batch);

    // TankBatch: route the decrement through the single SSoT writer
    // (TankBatchService.applyBatchDelta) so batchDetails[] — the per-batch
    // truth the web + mobile read models render — moves in lock-step with the
    // aggregates. It refuses an overdraft of this batch's share in this tank.
    if (tankBatch) {
      await this.tankBatchService.applyBatchDelta(
        manager,
        tenantId,
        input.tankId,
        {
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          quantityDelta: -input.quantityHarvested,
          biomassDelta: -biomassKg,
        },
        { volumeM3: Number(tank.waterVolume || tank.volume) || 0 },
      );
    }

    // Tank biomass. currentCount is derived + written by applyBatchDelta (the
    // SINGLE count writer) — biomass-ONLY update so it cannot clobber it.
    await manager
      .createQueryBuilder()
      .update(Tank)
      .set({ currentBiomass: Math.max(0, Number(tank.currentBiomass || 0) - biomassKg) })
      .where('id = :id', { id: tank.id })
      .execute();
    await this.farmStockProjection.refreshContainers(manager, tenantId, [input.tankId]);

    // P-31: today's unfed meals are re-priced in the same transaction; after a
    // full harvest the recalc sees an empty unit and cancels the rest.
    await this.dayPlanRecalc.recalcForUnit(manager, tenantId, input.tankId, 'harvest');

    const updatedTankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId: input.tankId },
    });
    if (updatedTankBatch) {
      tankOperation.postOperationState = {
        quantity: updatedTankBatch.totalQuantity,
        biomassKg: updatedTankBatch.totalBiomassKg,
        densityKgM3: updatedTankBatch.densityKgM3,
      };
      await manager.save(TankOperation, tankOperation);
    }

    // BatchHarvested into the transactional outbox BEFORE commit, with the
    // contract's own field names (harvestedQuantity, harvestedAt,
    // averageWeight, totalWeight).
    const harvestEvent: BatchHarvestedEvent = {
      ...createBaseEvent<BatchHarvestedEvent>('BatchHarvested', tenantId, {
        aggregateId: harvestRecord.batchId,
        aggregateType: 'Batch',
        version: 2,
      }),
      userId: recordedBy,
      batchId: harvestRecord.batchId,
      harvestedQuantity: harvestRecord.quantityHarvested,
      harvestedAt: toEventIso(harvestRecord.harvestDate),
      averageWeight: harvestRecord.averageWeight,
      totalWeight: harvestRecord.totalBiomass,
      isFinal: isFinalHarvest,
    };
    await this.outboxPublisher.enqueue(harvestEvent, manager);

    return { harvestRecord, isFinalHarvest, recordCode };
  }

  /**
   * FINAL-HARVEST → BATCH-CLOSURE CHAIN. Callers run this AFTER their
   * transaction committed: CloseBatchHandler opens its own transaction and
   * takes its own pessimistic_write lock on the batch row, so nesting it
   * would self-deadlock on that row.
   *
   * Failure policy: the harvest is already committed, so a closure failure
   * must NOT fail the request. The batch stays HARVESTED (the manual-close
   * entry state) and the BatchHarvested event carries isFinal=true, so
   * monitoring can detect a final harvest with no matching BatchClosed.
   */
  async closeBatchAfterFinalHarvest(
    tenantId: string,
    batchId: string,
    closedBy: string,
    recordCode: string,
  ): Promise<void> {
    try {
      await this.commandBus.execute(
        new CloseBatchCommand({
          tenantId,
          batchId,
          reason: BatchCloseReason.HARVEST_COMPLETED,
          closedBy,
          // Empty roles is safe by construction: the OTHER-reason admin gate
          // in CloseBatchHandler is never reached for HARVEST_COMPLETED.
          userRoles: [],
          notes: `Auto-close on final harvest ${recordCode}`,
        }),
      );
    } catch (closeError) {
      if (closeError instanceof BatchWithdrawalBlockedError) {
        // Expected compliance gate, NOT a system failure: an open medicine
        // withdrawal period makes CloseBatchHandler refuse to auto-close. The
        // operator closes manually with acknowledgeActiveTreatments. WARN —
        // no on-call page for correct behaviour.
        this.logger.warn(
          `Final harvest ${recordCode}: batch ${batchId} not auto-closed — open ` +
            `withdrawal period requires a manual close with acknowledgeActiveTreatments.`,
        );
      } else if (
        closeError instanceof BadRequestException &&
        closeError.message.includes('zaten kapatılmış')
      ) {
        // Idempotent double-final-harvest race: a concurrent close already
        // moved the batch to CLOSED. Benign — DEBUG not ERROR.
        this.logger.debug(
          `Final harvest ${recordCode}: batch ${batchId} already CLOSED (idempotent no-op).`,
        );
      } else {
        // Genuine closure failure: harvest committed but batch stuck in
        // HARVESTED. ERROR for on-call; manual closeBatch is the remedy.
        const failure = closeError instanceof Error ? closeError : new Error(String(closeError));
        this.logger.error(
          `Final harvest ${recordCode} committed but auto-close of batch ${batchId} failed — ` +
            `batch remains HARVESTED; close manually via closeBatch. Reason: ${failure.message}`,
          failure.stack,
        );
      }
    }
  }

  /**
   * Next sequential code (HR-2026-00001 / LOT-2026-00001) inside the caller's
   * transaction. The pessimistic_read lock on the last row prevents
   * concurrent requests from reading the same last sequence — duplicate lot
   * numbers break product-recall traceability.
   */
  private async generateCode(
    tenantId: string,
    prefix: 'HR' | 'LOT',
    manager: EntityManager,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const lastRecord = await manager
      .createQueryBuilder(HarvestRecord, 'hr')
      .where('hr.tenantId = :tenantId', { tenantId })
      .andWhere(prefix === 'HR' ? 'hr.recordCode LIKE :pattern' : 'hr.lotNumber LIKE :pattern', {
        pattern: `${prefix}-${year}-%`,
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
}
