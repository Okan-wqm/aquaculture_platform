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
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { MortalityRecordedEvent } from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource } from 'typeorm';

import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
  defaultMobileCommandReceiptsForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { toMortalityReasonCode } from '../../common/utils/reason-codecs';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { EquipmentType } from '../../equipment/entities/equipment-type.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank } from '../../tank/entities/tank.entity';
import { RecordMortalityCommand } from '../commands/record-mortality.command';
import { Batch } from '../entities/batch.entity';
import { MortalityRecord, MortalityCause, isMortalityCause } from '../entities/mortality-record.entity';
import { isMortalityReason } from '../entities/tank-operation.enums';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType, MortalityReason } from '../entities/tank-operation.entity';
import { MortalityCullPolicyService } from '../services/mortality-cull-policy.service';
import { TankBatchService } from '../services/tank-batch.service';
import { findTankOrEquipmentWithManager, resolveSiteIdFromDepartment } from '../utils/tank-lookup.util';

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
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly auditLogService: AuditLogService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    // SSoT tank-composition writer (batchDetails[] + derived aggregates + current*).
    private readonly tankBatchService: TankBatchService,
    private readonly mortalityCullPolicy: MortalityCullPolicyService = new MortalityCullPolicyService(),
    private readonly farmStockProjection: FarmStockProjectionService =
      defaultFarmStockProjectionForDirectHandlerConstruction(),
    private readonly mobileCommandReceipts: MobileCommandReceiptService =
      defaultMobileCommandReceiptsForDirectHandlerConstruction(),
  ) {}

  async execute(command: RecordMortalityCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // Backdate policy: mortality observations may land up to
    // MORTALITY_BACKDATE_LIMIT_DAYS (default 14) in the past —
    // operators sometimes batch-record a week's findings. Future
    // dates remain rejected unconditionally.
    const proposedDate: Date =
      payload.observedAt instanceof Date
        ? payload.observedAt
        : new Date(payload.observedAt);
    this.backdatePolicy.validate({
      context: 'mortality',
      proposedDate,
      subjectLabel: `batch ${batchId}`,
    });

    // All reads and writes inside a single transaction with pessimistic locks
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Declared inside the callback so it's accessible for event publishing and return
      let batch: Batch;

      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'recordMortality',
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

      // FARM-HIGH-052: mortality is stock-mutating, so it must carry an
      // idempotency envelope (clientCommandId + payloadHash). 'legacy' mode is
      // the no-key path where a retry would double-decrement stock; we REJECT it
      // here. The GraphQL input (RecordMortalityInput) and REST controller now
      // make the envelope mandatory, so this throw is structurally unreachable
      // from either front — it is the last-line backstop.
      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'recordMortality requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

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
        { mode: 'pessimistic_write' },
      );

      if (!tankLookup) {
        throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
      }

      const tank = tankLookup.equipment;

      // SEC-HIGH-051: object-level site authorization. The tank is already
      // loaded+locked above, so resolve its owning site from the known
      // departmentId (one Department lookup, serialized with the pessimistic
      // locks) and assert the caller is assigned to it BEFORE any stock write.
      // MODULE_MANAGER+ bypasses via the canonical hierarchy; a MODULE_USER not
      // assigned to the site — or an unresolved/site-less department — is DENIED.
      const tankSiteId = await resolveSiteIdFromDepartment(
        queryRunner.manager,
        tank.departmentId,
        tenantId,
      );
      this.siteAuth.assertSiteAssignment({
        caller: {
          sub: recordedBy,
          roles: command.userRoles,
          assignedSiteIds: command.callerAssignedSiteIds,
        },
        siteId: tankSiteId,
      });

      // FARM-CRITICAL-050: reject mortality on a terminal/closed batch. The batch
      // row is pessimistically locked above, so a concurrent status flip is
      // serialised. isOperational() (status-derived) is the authoritative gate —
      // isActive is an overloaded soft-delete flag and can lie post-transition.
      this.mortalityCullPolicy.assertStockMutable(batch);

      this.mortalityCullPolicy.assertQuantityWithinCurrent({
        operation: 'Mortality',
        quantity: payload.quantity,
        currentQuantity: batch.currentQuantity,
      });

      // FARM-LOW-050: cumulative removals (mortality + cull + harvest + this one)
      // must never exceed the initial stocked quantity. Hard lifecycle ceiling
      // the point-in-time currentQuantity check cannot catch on re-stock edges.
      this.mortalityCullPolicy.assertAggregateWithinInitial({
        batch,
        addedRemoval: payload.quantity,
      });

      // FARM-HIGH-053: load the tank's batch occupancy (pessimistically locked)
      // and assert this batch is actually held in this tank BEFORE writing any
      // row. A wrong/empty tankId would otherwise decrement a tank holding a
      // DIFFERENT batch and diverge batch-vs-tank inventory.
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
        lock: { mode: 'pessimistic_write' },
      });
      this.mortalityCullPolicy.assertBatchInTank({ batchId, tankBatch });

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
        // MortalityReason VALUES (lowercase) are a subset of MortalityCause's
        // VALUES, so a direct value match is the correct mapping. The previous
        // `MortalityCause[reason.toUpperCase()]` keyed by ENUM NAME and silently
        // fell back to UNKNOWN — that indirection was the coercion bug. Falls
        // back to OTHER only for a genuinely unmapped value.
        cause: this.toMortalityCause(payload.reason),
        causeDetail: payload.detail,
        notes: payload.notes,
        recordedBy,
      });

      await queryRunner.manager.save(MortalityRecord, mortalityRecord);

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
        // FARM-MEDIUM-052: payload.reason is already a valid SSoT MortalityReason
        // VALUE. The previous `MortalityReason[reason.toUpperCase()]` keyed the
        // enum by NAME against the OLD entity enum (which lacked PREDATION /
        // CANNIBALISM) and silently fell back to UNKNOWN — destroying cause
        // analytics. Persist the real reason; isMortalityReason guards a bad value.
        mortalityReason: isMortalityReason(payload.reason) ? payload.reason : MortalityReason.OTHER,
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

      // TankBatch update via the shared SSoT writer: decrement THIS batch in
      // batchDetails[], then re-derive totalQuantity/biomass/avg/density/current*
      // and stamp lastMortalityAt. assertBatchInTank above guarantees the batch
      // is held here, and the writer self-heals pre-SSoT single-batch rows that
      // carry empty batchDetails so the negative delta is never a silent no-op.
      if (tankBatch) {
        await this.tankBatchService.applyBatchDelta(
          queryRunner.manager,
          tenantId,
          payload.tankId,
          {
            batchId,
            batchNumber: batch.batchNumber,
            quantityDelta: -payload.quantity,
            biomassDelta: -biomassKg,
            lastMortalityAt: payload.observedAt,
          },
          { volumeM3: Number(tank.volume) || 0 },
        );
      }

      // Tank biomass update (Math.max prevents negatives). currentCount is now
      // derived + written by TankBatchService.applyBatchDelta (the SINGLE count
      // writer) above — writing it here too re-introduced the 900-vs-719 drift
      // (web equipment.currentCount vs mobile batchMetrics.pieces). currentBiomass
      // stays on its growth-tracking path; biomass-ONLY UPDATE (never a full-entity
      // save, which would clobber the derived currentCount).
      const newBiomass = Math.max(0, Number(tank.currentBiomass || 0) - biomassKg);
      if (tankLookup.isFromTanksTable && tankLookup.originalTank) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: newBiomass })
          .where('id = :id', { id: tankLookup.originalTank.id })
          .execute();
      } else {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Equipment)
          .set({ currentBiomass: newBiomass })
          .where('id = :id', { id: tank.id })
          .execute();
      }

      await this.farmStockProjection.refreshContainers(
        queryRunner.manager,
        tenantId,
        [payload.tankId],
      );

      // Enqueue MortalityRecordedEvent into the transactional outbox BEFORE commit.
      // The outbox INSERT is part of the same transaction as the domain writes —
      // either both commit or neither. OutboxWorkerService publishes to NATS
      // asynchronously with retry + dead-letter on failure.
      const mortalityEvent: MortalityRecordedEvent = {
        ...createBaseEvent<MortalityRecordedEvent>('MortalityRecorded', tenantId, { aggregateId: batchId, aggregateType: 'Batch' }),
        userId: recordedBy,
        batchId,
        tankId: payload.tankId,
        quantity: payload.quantity,
        reason: toMortalityReasonCode(payload.reason),
        mortalityDate: toEventIso(payload.observedAt),
        newTotalMortality: batch.totalMortality,
        newMortalityRate: batch.getMortalityRate(),
      };
      await this.outboxPublisher.enqueue(mortalityEvent, queryRunner.manager);

      // FARM-MEDIUM-054: durable audit trail for the stock removal. Written
      // through the txn manager (logWithManager) so the audit row commits or
      // rolls back atomically with the decrement + outbox row — never lies about
      // an event that didn't happen. Mirrors allocate-to-tank's CAPACITY_BLOCKED.
      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Batch',
        entityId: batchId,
        action: AuditAction.MORTALITY_RECORDED,
        userId: recordedBy,
        changes: {
          after: {
            tankId: payload.tankId,
            quantity: payload.quantity,
            reason: payload.reason,
            biomassKg,
            newCurrentQuantity: batch.currentQuantity,
            newTotalMortality: batch.totalMortality,
          },
        },
        metadata: { source: 'RecordMortalityHandler' },
        summary:
          `Mortality ${payload.quantity} from batch ${batch.batchNumber} ` +
          `tank ${payload.tankId} (${payload.reason})`,
      });

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'Batch',
        responseId: batch.id,
        responsePayload: { id: batch.id },
      });

      // Domain writes + outbox row are atomic — runInTenantTransaction commits.
      // Return the updated batch (GraphQL expects Batch, not MortalityRecord)
      return batch;
    });
  }

  /**
   * Map a MortalityReason VALUE to its MortalityCause counterpart by VALUE.
   *
   * MortalityReason VALUES are a subset of MortalityCause VALUES (both lowercase),
   * so a direct value match is correct and lossless. Falls back to OTHER for an
   * unmapped value rather than silently coercing to UNKNOWN.
   */
  private toMortalityCause(reason: string): MortalityCause {
    return isMortalityCause(reason) ? reason : MortalityCause.OTHER;
  }
}
