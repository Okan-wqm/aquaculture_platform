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
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { CullRecordedEvent } from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { RemovalQuantityPolicyService } from '../services/removal-quantity-policy.service';
import { Repository, DataSource } from 'typeorm';

import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
  defaultMobileCommandReceiptsForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { toCullReasonCode } from '../../common/utils/reason-codecs';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank } from '../../tank/entities/tank.entity';
import { RecordCullCommand } from '../commands/record-cull.command';
import { Batch } from '../entities/batch.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { MortalityCullPolicyService } from '../services/mortality-cull-policy.service';
import { TankBatchService } from '../services/tank-batch.service';
import { findTankOrEquipmentWithManager, resolveSiteIdFromDepartment } from '../utils/tank-lookup.util';

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
    private readonly removalQuantityPolicy: RemovalQuantityPolicyService,
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

  async execute(command: RecordCullCommand): Promise<Batch> {
    const { tenantId, batchId, payload, recordedBy } = command;

    // C-FARM-02: All reads moved inside the transaction with pessimistic_write
    // locks to eliminate the TOCTOU race condition. Two concurrent RecordCull
    // calls on the same batch previously both read currentQuantity BEFORE either
    // write, allowing both to pass the quantity check even if the sum exceeds
    // the real available count. The lock serialises them at the database level.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Declared inside the callback so the saved batch is accessible for return
      let batch: Batch;

      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'recordCull',
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

      // FARM-HIGH-052: cull is stock-mutating, so it must carry an idempotency
      // envelope (clientCommandId + payloadHash). 'legacy' mode is the no-key
      // path where a retry would double-decrement stock; we REJECT it. The
      // GraphQL input + REST controller now make the envelope mandatory, so this
      // throw is structurally unreachable from either front — last-line backstop.
      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'recordCull requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

      // Batch bul — pessimistic write lock prevents concurrent races
      const foundBatch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!foundBatch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }
      batch = foundBatch;

      // Tank bul — cull must support the same canonical tank lookup as
      // mortality: new tenants may store tanks in `equipment`, while existing
      // tenants can still have production tanks in the legacy `tanks` table.
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
      // departmentId (one Department lookup) and assert the caller is assigned to
      // it BEFORE any stock write. MODULE_MANAGER+ bypasses; an unassigned or
      // unresolved site for a MODULE_USER is DENIED.
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

      // FARM-CRITICAL-050: reject cull on a terminal/closed batch. isOperational()
      // (status-derived) is the authoritative gate — isActive is an overloaded
      // soft-delete flag that can stay true after a terminal status transition.
      this.mortalityCullPolicy.assertStockMutable(batch);

      this.mortalityCullPolicy.assertQuantityWithinCurrent({
        operation: 'Cull',
        quantity: payload.quantity,
        currentQuantity: batch.currentQuantity,
      });

      // FARM-LOW-050: cumulative removals (mortality + cull + harvest + this one)
      // must never exceed the initial stocked quantity.
      this.mortalityCullPolicy.assertAggregateWithinInitial({
        batch,
        addedRemoval: payload.quantity,
      });

      // Biomass hesapla
      // D-3 miktar çözümü (SSoT) — mortality ile aynı üç-mod semantiği.
      const avgWeightG = payload.avgWeightG || batch.getCurrentAvgWeight();
      const resolvedRemoval = this.removalQuantityPolicy.resolve({
        count: payload.quantity,
        biomassKg: payload.biomassKg,
        currentQuantity: batch.currentQuantity,
        // Türetilmiş güncel biyokütle (adet × etkin ortalama) — ceiling doğrulaması için.
        currentBiomassKg: (batch.currentQuantity * avgWeightG) / 1000,
        currentAvgWeightG: avgWeightG,
      });
      const biomassKg = resolvedRemoval.biomassKg;

      // TankBatch bul (inside TX for consistency).
      // FARM-MEDIUM-055: pessimistic_write lock — parity with mortality. Without
      // it, two concurrent culls (or a cull racing a mortality) read totalQuantity
      // before either writes → TOCTOU under-decrement / lost update on the tank row.
      // FARM-HIGH-053: assert this batch is actually held in this tank before any
      // decrement, so a wrong/empty tankId cannot diverge batch-vs-tank inventory.
      const tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
        lock: { mode: 'pessimistic_write' },
      });
      this.mortalityCullPolicy.assertBatchInTank({ batchId, tankBatch });

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
        // payload.reason is already the SSoT CullReason (same identity as the
        // @Column enum now). The previous `as CullReason` cast masked the
        // entity/command enum mismatch (FARM-HIGH-054) — deleted.
        cullReason: payload.reason,
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

      // TankBatch update via the shared SSoT writer: decrement THIS batch in
      // batchDetails[], then re-derive totalQuantity/biomass/avg/density/current*.
      // The writer self-heals pre-SSoT single-batch rows (empty batchDetails) so
      // the negative cull delta is never a silent no-op on a pre-existing tank.
      // P-31: cull sonrası bugünün beslenmemiş öğünleri, stok kapsamı kapanırken
      // aynı tx'te yeniden fiyatlanır (artık ayrı hatırlanan bir çağrı değil).
      if (tankBatch) {
        await this.tankBatchService.applyStockChange(
          queryRunner.manager,
          tenantId,
          'cull',
          (stock) =>
            stock.applyDelta(
              payload.tankId,
              {
                batchId,
                batchNumber: batch.batchNumber,
                quantityDelta: -payload.quantity,
                biomassDelta: -biomassKg,
              },
              { volumeM3: Number(tank.volume) || 0 },
            ),
        );
      }

      // Tank biomass update (Math.max prevents negatives). currentCount is now
      // derived + written by TankBatchService.applyBatchDelta (the SINGLE count
      // writer) above — no independent count write here (that drifted from
      // tank_batches, the SSoT). currentBiomass stays on its growth-tracking path;
      // biomass-ONLY UPDATE (never a full-entity save, which would clobber the
      // derived currentCount).
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
        culledAt: toEventIso(payload.culledAt),
        newCullCount: batch.cullCount,
        newCurrentQuantity: batch.currentQuantity,
      };
      await this.outboxPublisher.enqueue(cullEvent, queryRunner.manager);

      // FARM-MEDIUM-054: durable audit trail for the cull removal, written
      // through the txn manager so it commits or rolls back atomically with the
      // decrement + outbox row. Mirrors allocate-to-tank's CAPACITY_BLOCKED row.
      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Batch',
        entityId: batchId,
        action: AuditAction.CULL_RECORDED,
        userId: recordedBy,
        changes: {
          after: {
            tankId: payload.tankId,
            quantity: payload.quantity,
            reason: payload.reason,
            biomassKg,
            newCurrentQuantity: batch.currentQuantity,
            newCullCount: batch.cullCount,
          },
        },
        metadata: { source: 'RecordCullHandler' },
        summary:
          `Cull ${payload.quantity} from batch ${batch.batchNumber} ` +
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
      return batch;
    });
  }
}
