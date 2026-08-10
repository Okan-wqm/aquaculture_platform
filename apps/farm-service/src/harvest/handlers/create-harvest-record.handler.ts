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
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandBus, CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type { BatchHarvestedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource } from 'typeorm';

import { CloseBatchCommand, BatchCloseReason } from '../../batch/commands/close-batch.command';
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { TankBatchService } from '../../batch/services/tank-batch.service';
import { BatchWithdrawalBlockedError } from '../../common/errors/farm-errors';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
  defaultMobileCommandReceiptsForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { Tank } from '../../tank/entities/tank.entity';
import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { HarvestMethod, ProductForm } from '../entities/harvest-plan.entity';
import {
  HarvestRecord,
  HarvestRecordStatus,
  HarvestOperation,
  LotInfo,
} from '../entities/harvest-record.entity';
import { HarvestPolicyService } from '../services/harvest-policy.service';

@Injectable()
@CommandHandler(CreateHarvestRecordCommand)
// Return HarvestRecord so the GraphQL resolver can expose harvest-specific fields to clients
export class CreateHarvestRecordHandler
  implements ICommandHandler<CreateHarvestRecordCommand, HarvestRecord>
{
  private readonly logger = new Logger(CreateHarvestRecordHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly commandBus: CommandBus,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly harvestPolicy: HarvestPolicyService,
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
    // Single SSoT writer for tank composition — harvest decrements the tank's
    // batchDetails[] through this, never by hand (see the applyBatchDelta call).
    private readonly tankBatchService: TankBatchService,
    // Currency SSoT (FARM-HIGH-151): harvest_records.totalRevenue feeds the
    // HARVEST_REVENUE derived-cost line — the currency must be the tenant
    // default from finance_settings, never a hardcoded literal.
    private readonly financeSettings: FinanceSettingsService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    // Required param placed before the default-valued ones below.
    private readonly siteAuth: SiteAuthorizationService = new SiteAuthorizationService(),
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
    private readonly mobileCommandReceipts: MobileCommandReceiptService = defaultMobileCommandReceiptsForDirectHandlerConstruction(),
    @Optional()
    private readonly metricsService?: FarmDomainMetricsService,
  ) {}

  async execute(command: CreateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, input, recordedBy } = command;

    // Parse harvestDate early (no DB needed)
    const harvestDate =
      typeof input.harvestDate === 'string' ? new Date(input.harvestDate) : input.harvestDate;

    // Backdate policy: harvest may be logged up to HARVEST_BACKDATE_LIMIT_DAYS
    // (default 7) after the physical event. Future dates are rejected
    // unconditionally — a harvest record with a harvestDate in the future
    // would falsely advance lot traceability timelines.
    this.backdatePolicy.validate({
      context: 'harvest',
      proposedDate: harvestDate,
      subjectLabel: `batch ${input.batchId}`,
    });

    // The Norwegian quality class is the sole stored quality taxonomy (RPT-007)
    // and a required input (the DTO enforces the enum).
    const qualityClass = input.qualityClass;

    // Currency SSoT (FARM-HIGH-151): resolve the tenant default before the
    // transaction so revenue + customer-delivery lines book in it.
    const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);

    // All reads and writes inside a single transaction with pessimistic locks.
    // The fail-closed tenant boundary pins search_path + the RLS GUC and
    // commits / rolls back / releases around the callback.
    const result = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
          tableName: 'farm_mobile_command_receipts',
          tenantId,
          envelope: command.mobileCommand,
          operationType: 'createHarvestRecord',
          responseType: 'HarvestRecord',
        });
        if (receipt.mode === 'replay') {
          const replayed = receipt.responseId
            ? await queryRunner.manager.findOne(HarvestRecord, {
                where: { id: receipt.responseId, tenantId },
              })
            : null;
          if (!replayed) {
            throw new ConflictException('Mobile command receipt response is no longer available');
          }
          // Replay short-circuits the write path: no final-harvest close
          // chain re-runs (the original harvest already dispatched it).
          return { harvestRecord: replayed, isFinalHarvest: false, recordCode: null };
        }

        // Batch bul with pessimistic lock
        const batch = await queryRunner.manager.findOne(Batch, {
          where: { id: input.batchId, tenantId, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });

        if (!batch) {
          throw new NotFoundException(`Batch ${input.batchId} bulunamadı`);
        }

        // ── COMPLIANCE GATE: medicine withdrawal period ─────────────────────
        //
        // Food-safety rule (Norwegian Mattilsynet, EU Reg 37/2010):
        // harvesting a batch before the medicine withdrawal period has
        // elapsed puts unsafe fish on the market. The check runs outside
        // the batch row's pessimistic_write lock (separate table) so it
        // cannot deadlock; it runs INSIDE the transaction so a concurrent
        // resolveHealthEvent cannot clear the block between the check and
        // the harvest write.
        //
        // Blocking logic lives in BatchHarvestEligibilityService so the
        // GraphQL query `batchHarvestEligibility` can reuse it for UI
        // pre-submit warnings. See docs/illustrator/ (Girdi 14h).
        const eligibility = await this.harvestEligibility.checkEligibility(
          tenantId,
          input.batchId,
          harvestDate,
        );
        if (!eligibility.eligible) {
          this.metricsService?.incWithdrawalBlock({
            tenantId,
            surface: 'harvest_record',
          });
          throw new BatchWithdrawalBlockedError({
            userMessage:
              eligibility.reason ?? 'Harvest blocked by active medicine withdrawal period.',
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
        // overridable) MUST cite an APPROVED / SCHEDULED / IN_PROGRESS
        // harvest plan for the same batch. Small harvests may continue
        // without a plan but land a log entry so ops can track how often
        // the shortcut is used. See HarvestPolicyService for the rule
        // details and Girdi 15-B10 in
        // docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md.
        await this.harvestPolicy.evaluate({
          tenantId,
          batchId: input.batchId,
          projectedBiomassKg: Number(input.totalBiomass || 0),
          projectedQuantity: Number(input.quantityHarvested || 0),
          harvestPlanId: input.harvestPlanId ?? null,
        });

        // Tank bul with pessimistic lock
        const tank = await queryRunner.manager.findOne(Tank, {
          where: { id: input.tankId, tenantId, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });

        if (!tank) {
          throw new NotFoundException(`Tank ${input.tankId} bulunamadı`);
        }

        // SEC-HIGH-051: object-level site authorization. Resolve the tank's owning
        // site inside this transaction and assert the caller is assigned to it
        // BEFORE any harvest write. MODULE_MANAGER+ bypasses (and the @Roles floor
        // already restricts harvest to MODULE_MANAGER+, see SEC-MEDIUM-050); a
        // site-less/unresolved tank is DENIED.
        const tankSiteId = await resolveTankSiteId(queryRunner.manager, input.tankId, tenantId);
        this.siteAuth.assertSiteAssignment({
          caller: {
            sub: recordedBy,
            roles: command.userRoles,
            assignedSiteIds: command.callerAssignedSiteIds,
          },
          siteId: tankSiteId,
        });

        if (input.quantityHarvested > batch.currentQuantity) {
          throw new BadRequestException(
            `Harvest miktarı (${input.quantityHarvested}) batch'in mevcut miktarından (${batch.currentQuantity}) fazla olamaz`,
          );
        }

        // TankBatch with pessimistic lock
        const tankBatch = await queryRunner.manager.findOne(TankBatch, {
          where: { tenantId, tankId: input.tankId },
          lock: { mode: 'pessimistic_write' },
        });

        if (tankBatch && input.quantityHarvested > tankBatch.totalQuantity) {
          throw new BadRequestException(
            `Harvest miktarı (${input.quantityHarvested}) tank'taki miktardan (${tankBatch.totalQuantity}) fazla olamaz`,
          );
        }

        // Biomass hesapla
        const biomassKg =
          input.totalBiomass || (input.quantityHarvested * input.averageWeight) / 1000;

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
        const preOperationState = tankBatch
          ? {
              quantity: tankBatch.totalQuantity,
              biomassKg: tankBatch.totalBiomassKg,
              densityKgM3: tankBatch.densityKgM3,
            }
          : undefined;

        // HarvestRecord oluştur
        const harvestRecord = queryRunner.manager.create(HarvestRecord, {
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
          // (RPT-007). qualityGrade is a read-only derived alias — not stored.
          qualityClass,
          lotInfo,
          supervisorId: recordedBy,
          notes: input.notes,
          totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined,
          currency: input.pricePerKg ? defaultCurrency : undefined,
        });

        // Customer delivery bilgisi ekle
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

        // Tüm stok hasad edildiyse batch'i HARVESTED olarak işaretle.
        // Single source for the BatchHarvested.isFinal signal (FARM-LOW-004):
        // the SAME post-decrement value gates the HARVESTED status below AND
        // the event field — no recompute, no drift.
        const isFinalHarvest = batch.currentQuantity <= 0;
        if (isFinalHarvest) {
          batch.status = BatchStatus.HARVESTED;
          batch.statusChangedAt = new Date();
          batch.actualHarvestDate = new Date();
        }

        await queryRunner.manager.save(Batch, batch);

        // TankBatch: route the harvest decrement through the single SSoT writer
        // (TankBatchService.applyBatchDelta) so batchDetails[] — the per-batch
        // truth the web + mobile read models render — is decremented in lock-step
        // with the aggregates, instead of being left stale (the class of drift that
        // made the web panel show 900 while mobile showed 719). Derives every
        // aggregate + removes the batch from the composition when it reaches zero.
        // Mirrors the mortality/cull/transfer write paths (one writer, no drift).
        // P-31: hasat sonrası bugünün beslenmemiş öğünleri, stok kapsamı
        // kapanırken aynı tx'te yeniden fiyatlanır; tam hasatta recalc üniteyi
        // boş görür → kalan öğünler iptal + atama otomatik pause (unit_emptied).
        if (tankBatch) {
          await this.tankBatchService.applyStockChange(
            queryRunner.manager,
            tenantId,
            'harvest',
            (stock) =>
              stock.applyDelta(
                input.tankId,
                {
                  batchId: batch.id,
                  batchNumber: batch.batchNumber,
                  quantityDelta: -input.quantityHarvested,
                  biomassDelta: -biomassKg,
                },
                { volumeM3: Number(tank.waterVolume || tank.volume) || 0 },
              ),
          );
        }

        // Tank biomass update. currentCount is derived + written by
        // TankBatchService.applyBatchDelta (the SINGLE count writer) above — no
        // independent count write here (that drifted from tank_batches). biomass-ONLY
        // UPDATE so it can't clobber the derived currentCount.
        await queryRunner.manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentBiomass: Math.max(0, Number(tank.currentBiomass || 0) - biomassKg) })
          .where('id = :id', { id: tank.id })
          .execute();
        await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [
          input.tankId,
        ]);

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
        await this.outboxPublisher.enqueue(harvestEvent, queryRunner.manager);
        await this.mobileCommandReceipts.complete(queryRunner.manager, {
          tableName: 'farm_mobile_command_receipts',
          receipt,
          responseType: 'HarvestRecord',
          responseId: harvestRecord.id,
          responsePayload: { id: harvestRecord.id },
        });

        // Domain writes + outbox row commit atomically when the boundary
        // commits the callback. The final-harvest close chain runs AFTER the
        // commit (below), never inside this transaction.
        return { harvestRecord, isFinalHarvest, recordCode };
      },
    );

    const { harvestRecord, isFinalHarvest, recordCode } = result;

    // ── FINAL-HARVEST → BATCH-CLOSURE CHAIN ─────────────────────────
    //
    // A batch whose stock reached 0 must not linger in HARVESTED with no
    // frozen final metrics: CloseBatchHandler is the single owner of the
    // CLOSED transition and of freezing finalFCR / mortality /
    // daysInProduction into the BatchClosed event. Dispatch runs AFTER
    // commit — CloseBatchHandler opens its own transaction and takes its
    // own pessimistic_write lock on the batch row, so nesting it inside
    // this transaction would self-deadlock on the same row.
    //
    // Failure policy: the harvest is already committed, so a closure
    // failure must NOT fail the request. The batch stays in HARVESTED
    // (the manual-close entry state) and the BatchHarvested event above
    // carries isFinal=true, so monitoring can detect a final harvest with
    // no matching BatchClosed.
    if (isFinalHarvest) {
      try {
        await this.commandBus.execute(
          new CloseBatchCommand({
            tenantId,
            batchId: input.batchId,
            reason: BatchCloseReason.HARVEST_COMPLETED,
            closedBy: recordedBy,
            // Empty roles is safe by construction: the OTHER-reason admin
            // gate in CloseBatchHandler is never reached because the
            // reason is HARVEST_COMPLETED, not OTHER.
            userRoles: [],
            notes: `Auto-close on final harvest ${recordCode}`,
          }),
        );
      } catch (closeError) {
        if (closeError instanceof BatchWithdrawalBlockedError) {
          // Expected compliance gate, NOT a system failure: the batch has
          // an open medicine-withdrawal period, so CloseBatchHandler
          // correctly refuses to auto-close (food-safety — Mattilsynet /
          // EU Reg 37/2010; closing would hide the open treatment). The
          // operator must close manually with acknowledgeActiveTreatments.
          // WARN (actionable) not ERROR — no on-call page for correct
          // behaviour.
          this.logger.warn(
            `Final harvest ${recordCode}: batch ${input.batchId} not ` +
              `auto-closed — open withdrawal period requires a manual ` +
              `close with acknowledgeActiveTreatments.`,
          );
        } else if (
          closeError instanceof BadRequestException &&
          (closeError as Error).message.includes('zaten kapatılmış')
        ) {
          // Idempotent double-final-harvest race: a concurrent close
          // already moved the batch to CLOSED. Benign — DEBUG not ERROR.
          this.logger.debug(
            `Final harvest ${recordCode}: batch ${input.batchId} already ` +
              `CLOSED (idempotent no-op).`,
          );
        } else {
          // Genuine closure failure: harvest committed but batch stuck in
          // HARVESTED. ERROR for on-call; manual closeBatch is the remedy.
          this.logger.error(
            `Final harvest ${recordCode} committed but auto-close of batch ` +
              `${input.batchId} failed — batch remains HARVESTED; close ` +
              `manually via closeBatch. Reason: ${(closeError as Error).message}`,
            (closeError as Error).stack,
          );
        }
      }
    }

    // Return the created harvest record so clients get harvest-specific fields
    return harvestRecord;
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
