/**
 * CloseBatchHandler
 *
 * CloseBatchCommand'ı işler ve batch'i kapatır.
 *
 * Phase A refactor:
 * - Replaced DomainEventPublisher (post-commit fire-and-forget) with
 *   OutboxPublisher (pre-commit transactional). BatchClosed events are
 *   now delivered with at-least-once guarantee even when NATS is down.
 * - All reads moved inside the transaction with pessimistic_write lock to
 *   eliminate the TOCTOU race where the batch could mutate between the
 *   pre-read and the actual close.
 * - Event payload now includes ALL contract-required fields:
 *   `closedAt`, `totalMortality`, `mortalityRate`, `daysInProduction`,
 *   `finalFCR`, `finalQuantity`, `finalBiomassKg`. Previous implementation
 *   silently dropped `closedAt` and `totalMortality` due to the loose
 *   `IEvent & Record<string, unknown>` type that bypassed contract checks.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role, hasAnyRole } from '@aquaculture/backend-common/decorators';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type { BatchClosedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { BatchWithdrawalBlockedError } from '../../common/errors/farm-errors';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { BatchHarvestEligibilityService } from '../../fish-health/services/batch-harvest-eligibility.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { CloseBatchCommand, BatchCloseReason } from '../commands/close-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { BatchLifecyclePolicyService } from '../services/batch-lifecycle-policy.service';
import { BatchAggregateMutationPort } from '../batch-aggregate-mutation.port';

@Injectable()
@CommandHandler(CloseBatchCommand)
export class CloseBatchHandler implements ICommandHandler<CloseBatchCommand, Batch> {
  private readonly logger = new Logger(CloseBatchHandler.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
    private readonly lifecyclePolicy: BatchLifecyclePolicyService,
    private readonly fcrCalculation: FCRCalculationService,
    @Optional()
    private readonly metricsService?: FarmDomainMetricsService,
  ) {}

  async execute(command: CloseBatchCommand): Promise<Batch> {
    const { tenantId, batchId, reason, notes, closedBy, userRoles, acknowledgeActiveTreatments } =
      command;

    const savedBatch = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const batchRepo = tenantManagerRepo(queryRunner.manager, Batch, tenantId);
        // Batch bul (inside TX with pessimistic lock — eliminates TOCTOU race
        // where the batch could be mutated between pre-read and the close write).
        const batch = await batchRepo.findOne({
          where: { id: batchId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!batch) {
          throw new NotFoundException(`Batch ${batchId} bulunamadı`);
        }

        // Zaten kapalı mı kontrol et
        if (batch.status === BatchStatus.CLOSED) {
          throw new BadRequestException(`Batch ${batchId} zaten kapatılmış`);
        }

        // ── COMPLIANCE GATE: medicine withdrawal period on close ────────
        //
        // If the batch has active HealthEvent rows whose
        // earliestHarvestDate lies in the future, closing the batch
        // would hide the open treatment from downstream reporting
        // (dashboards filter out closed batches). The operator must
        // acknowledge the open treatments explicitly — the boolean flag
        // on CloseBatchCommand is persisted in the audit log so the
        // acknowledgement is traceable.
        //
        // Unlike the admin-override on BatchCloseReason.OTHER, this
        // gate cannot be bypassed by role. Food-safety compliance
        // (Mattilsynet / EU Reg 37/2010) applies regardless of who is
        // closing the batch.
        const eligibility = await this.harvestEligibility.checkEligibility(
          tenantId,
          batchId,
          new Date(),
        );
        if (!eligibility.eligible && !acknowledgeActiveTreatments) {
          this.metricsService?.incWithdrawalBlock({
            tenantId,
            surface: 'close_batch',
          });
          const titles = eligibility.blockingEvents.map((e) => `"${e.title}"`).join(', ');
          throw new BatchWithdrawalBlockedError({
            userMessage:
              `Batch ${batchId} has ${eligibility.blockingEvents.length} active ` +
              `health event(s) with open withdrawal periods (${titles}). ` +
              `Earliest permissible harvest date: ` +
              `${eligibility.blockedUntil?.toISOString().slice(0, 10)}. ` +
              `Set acknowledgeActiveTreatments=true on the close request to ` +
              `accept the override (will be audit-logged).`,
            activeTreatments: eligibility.blockingEvents.map((e) => ({
              eventCode: e.id,
              productName: e.title,
              earliestHarvestDate: e.earliestHarvestDate.toISOString(),
              daysRemaining: Math.max(
                0,
                Math.ceil((e.earliestHarvestDate.getTime() - Date.now()) / 86_400_000),
              ),
            })),
            fieldPath: ['closeBatch', 'id'],
          });
        }
        if (!eligibility.eligible && acknowledgeActiveTreatments) {
          this.logger.warn(
            `Batch ${batchId} closed with ${eligibility.blockingEvents.length} ` +
              `active treatment(s) acknowledged by ${closedBy} ` +
              `(tenant ${tenantId.slice(0, 8)}...). ` +
              `Blocking events: ${eligibility.blockingEvents.map((e) => e.id).join(', ')}`,
          );
        }

        // SECURITY: BatchCloseReason.OTHER bypasses the lifecycle invariant.
        // It is restricted to admin-only override paths. Regular users MUST
        // close batches through the correct lifecycle (harvest, transfer, fail, cancel).
        // This prevents premature closure of ACTIVE batches via OTHER reason.
        if (reason === BatchCloseReason.OTHER) {
          const isAdmin = userRoles.some((r) =>
            hasAnyRole(r, [Role.SUPER_ADMIN, Role.TENANT_ADMIN]),
          );
          if (!isAdmin) {
            throw new ForbiddenException(
              `BatchCloseReason.OTHER is restricted to admin users. ` +
                `Regular users must close batches through the correct lifecycle ` +
                `(HARVEST_COMPLETED, TRANSFERRED, FAILED, CANCELLED).`,
            );
          }
          this.logger.warn(
            `Admin override: batch ${batchId} closed with OTHER reason by ${closedBy}, tenant: ${tenantId}`,
          );
        }

        this.lifecyclePolicy.assertCanCloseForReason(batch, reason);

        // Compute-at-close: freeze the authoritative final metrics here, inside
        // the pessimistic_write block, so the persisted batch row and the
        // BatchClosed event agree and can never be recomputed against later state.
        //
        // - finalFCR comes from the SINGLE FCR authority
        //   (FcrCalculationService.calculateCumulativeFCR), which derives realized
        //   growth from the TankOperation ledger + the live count. The previous
        //   `batch.fcr.actual` read returned whatever the shadow updateBatchMetrics
        //   path last persisted (often 0 / stale), so the closed event carried a
        //   wrong FCR (FARM-MEDIUM-003).
        // - finalBiomassKg is the derive-on-read value (currentQuantity ×
        //   effectiveAvgWeightG / 1000), replacing the stale getCurrentBiomass
        //   snapshot read. At CLOSED there are no further removals, so freezing
        //   the snapshot here is the one correct place to persist it.
        const cumulativeFcr = await this.fcrCalculation.calculateCumulativeFCR(batchId, tenantId);
        const finalFCR = cumulativeFcr.fcr;
        const finalBiomassKg = batch.getCurrentBiomass();

        const finalMetrics = {
          finalQuantity: batch.currentQuantity,
          finalBiomass: finalBiomassKg,
          finalAvgWeight: batch.getCurrentAvgWeight(),
          totalMortality: batch.totalMortality,
          mortalityRate: batch.getMortalityRate(),
          survivalRate: batch.getSurvivalRate(),
          retentionRate: batch.getRetentionRate(),
          totalFeedConsumed: batch.totalFeedConsumed,
          fcr: finalFCR,
          sgr: batch.sgr,
          daysInProduction: batch.getDaysInProduction(),
          costPerKg: batch.costPerKg,
        };

        const closedAt = new Date();

        // Batch'i kapat
        batch.status = BatchStatus.CLOSED;
        batch.isActive = false;
        batch.statusChangedAt = closedAt;
        batch.statusReason = `${reason}: ${notes || ''}`.trim();
        batch.updatedBy = closedBy;

        // Growth metrics güncelle
        batch.growthMetrics.daysInProduction = finalMetrics.daysInProduction;

        // Persist the frozen final FCR + biomass onto the batch row in the same
        // tx, so the closed record is the authoritative snapshot. fcr.actual is
        // the column-backed FCR; weight.actual.totalBiomass freezes the at-close
        // derived biomass (no further removals occur once CLOSED).
        batch.fcr.actual = finalFCR;
        batch.fcr.lastUpdatedAt = closedAt;
        if (batch.weight?.actual) {
          batch.weight.actual.totalBiomass = finalBiomassKg;
        }

        // Hasat tarihi yoksa ve harvest completed ise şimdi ata
        if (reason === BatchCloseReason.HARVEST_COMPLETED && !batch.actualHarvestDate) {
          batch.actualHarvestDate = closedAt;
        }

        const savedBatch = await this.batchMutations.commitBatchTransition(mutationSession, {
          intent: 'batch_close',
          aggregate: batch,
        });

        // Enqueue BatchClosedEvent into the transactional outbox BEFORE commit.
        // All required contract fields are populated — `closedAt` and `totalMortality`
        // were silently dropped by the previous implementation due to type-loose
        // publish API. With OutboxPublisher.enqueue<BaseEvent>, the cast to the
        // typed contract is enforced.
        const closedEvent: BatchClosedEvent = {
          ...createBaseEvent<BatchClosedEvent>('BatchClosed', tenantId, {
            aggregateId: savedBatch.id,
            aggregateType: 'Batch',
          }),
          timestamp: closedAt.toISOString(),
          userId: closedBy,
          batchId: savedBatch.id,
          closeReason: reason,
          finalQuantity: finalMetrics.finalQuantity,
          finalBiomassKg: finalMetrics.finalBiomass,
          finalFCR: finalMetrics.fcr,
          totalMortality: finalMetrics.totalMortality,
          mortalityRate: finalMetrics.mortalityRate,
          daysInProduction: finalMetrics.daysInProduction,
          closedAt: toEventIso(closedAt),
        };
        await this.outboxPublisher.enqueue(closedEvent, queryRunner.manager);
        return savedBatch;
      },
    );

    this.logger.log(`Batch ${batchId} closed — reason: ${reason}, tenant: ${tenantId}`);

    return savedBatch;
  }
}
