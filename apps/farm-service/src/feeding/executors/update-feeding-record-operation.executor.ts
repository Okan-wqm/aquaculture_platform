import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  toEventIso,
  type FeedingRecordUpdatedEvent,
} from '@platform/event-contracts';

import type {
  FeedingRecordOperationResult,
  UpdateFeedingRecordOperationCommand,
} from '../../feeding-protocol/feeding-operation-command';
import type { FeedingRecordUpdateOperationHandler } from '../../feeding-protocol/feeding-operation-handler';
import { round3 } from '../../common/utils/rounding.util';
import type {
  FeedingOperationSession,
  VerifiedFeedingOperationSession,
} from '../../feeding-protocol/feeding-operation-session';
import {
  feedingOperationObservedAt,
  readFeedingOperationSession,
} from '../../feeding-protocol/feeding-operation-session';
import { FeedingDayPlan } from '../../feeding-protocol/entities/feeding-day-plan.entity';
import {
  BiomassGrowthApplierService,
  type UnitGrowthMutationScopeV1,
} from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { FeedingRecord } from '../entities/feeding-record.entity';
import { FeedingStorageCorrectionService } from '../services/feeding-storage-correction.service';
import { projectFeedingRecordOperationResult } from './feeding-record-operation-result';
import { FeedingAggregateMutationPort } from '../../feeding-protocol/feeding-aggregate-mutation.writer';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

/** Governed correction executor; admission, replay and transaction are coordinator-owned. */
@Injectable()
export class UpdateFeedingRecordOperationExecutor implements FeedingRecordUpdateOperationHandler {
  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly storageCorrection: FeedingStorageCorrectionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async executeUpdateFeedingRecordOperation(
    session: FeedingOperationSession,
    command: UpdateFeedingRecordOperationCommand,
  ): Promise<FeedingRecordOperationResult> {
    const context = readFeedingOperationSession(session);
    const manager = context.manager;
    const preview = await manager.findOne(FeedingRecord, {
      where: { id: command.feedingRecordId, tenantId: command.tenantId },
    });
    if (!preview) {
      throw new NotFoundException(`Feeding record ${command.feedingRecordId} bulunamadı`);
    }
    if (preview.mealId != null) {
      throw new BadRequestException(
        `Feeding record ${command.feedingRecordId} bir öğün dökümüne bağlı; correctMealPour kullanın`,
      );
    }

    const requestedAmount = command.payload.actualAmount;
    const currentAmount = Number(preview.actualAmount);
    const amountDelta = requestedAmount === undefined ? 0 : round3(requestedAmount - currentAmount);
    if (amountDelta === 0) {
      return this.persistUpdate(context, command, preview, amountDelta, null);
    }
    if (!context.unitId || !context.siteId || !preview.dayPlanId) {
      throw new ConflictException(
        'A feeding amount correction requires governed unit, Site and day-plan provenance',
      );
    }
    const execution = await this.growthApplier.withUnitGrowthMutation(
      manager,
      context.mutationSession,
      command.tenantId,
      context.unitId,
      context.mutationInstant,
      (scope) => this.persistUpdate(context, command, preview, amountDelta, scope),
    );
    if (!execution) {
      throw new ConflictException(
        `Feeding record batch ${preview.batchId} has no locked unit projection`,
      );
    }
    return execution;
  }

  private async persistUpdate(
    context: VerifiedFeedingOperationSession,
    command: UpdateFeedingRecordOperationCommand,
    preview: FeedingRecord,
    amountDelta: number,
    growthScope: UnitGrowthMutationScopeV1 | null,
  ): Promise<FeedingRecordOperationResult> {
    const manager = context.manager;
    const observedAt = feedingOperationObservedAt(context);
    const requestedAmount = command.payload.actualAmount;
    const lockedBatch = growthScope?.batches.get(preview.batchId);
    let dayPlan: FeedingDayPlan | undefined;
    if (amountDelta !== 0) {
      if (
        !growthScope ||
        !lockedBatch ||
        !context.unitId ||
        !context.siteId ||
        !preview.dayPlanId
      ) {
        throw new ConflictException(
          `Feeding record batch ${preview.batchId} is outside the locked unit projection`,
        );
      }
      dayPlan =
        (await manager.findOne(FeedingDayPlan, {
          where: { id: preview.dayPlanId, tenantId: command.tenantId },
          lock: { mode: 'pessimistic_write' },
        })) ?? undefined;
      if (!dayPlan || dayPlan.unitId !== context.unitId || dayPlan.siteId !== context.siteId) {
        throw new ConflictException('Feeding record day-plan provenance changed during correction');
      }
    }

    const record = await manager.findOne(FeedingRecord, {
      where: { id: command.feedingRecordId, tenantId: command.tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!record || record.batchId !== preview.batchId || record.mealId != null) {
      throw new ConflictException('Feeding record identity changed during correction admission');
    }

    const previousAmount = Number(record.actualAmount);
    const previousCost = Number(record.feedCost ?? 0);
    if (!Number.isFinite(previousAmount) || previousAmount < 0 || !Number.isFinite(previousCost)) {
      throw new ConflictException('Feeding record has invalid historical amount/cost provenance');
    }
    const historicalUnitCost = previousAmount > 0 ? previousCost / previousAmount : 0;
    const correctedAmount = requestedAmount ?? previousAmount;
    const correctedCost = round3(historicalUnitCost * correctedAmount);

    if (requestedAmount !== undefined) record.actualAmount = requestedAmount;
    if (command.payload.wasteAmount !== undefined) {
      record.wasteAmount = command.payload.wasteAmount;
    }
    if (command.payload.environment !== undefined) record.environment = command.payload.environment;
    if (command.payload.fishBehavior !== undefined) {
      record.fishBehavior = command.payload.fishBehavior;
    }
    if (command.payload.notes !== undefined) record.notes = command.payload.notes;
    if (command.payload.verifiedBy !== undefined) {
      record.verifiedBy = command.payload.verifiedBy;
      record.verifiedAt = observedAt;
    }
    if (amountDelta !== 0) record.feedCost = correctedCost;
    record.calculateVariance();
    const saved = await this.feedingMutations.commitFeedingRecordTransition(
      context.mutationSession,
      { intent: 'corrected', aggregate: record },
    );

    if (amountDelta !== 0 && growthScope && lockedBatch && dayPlan && context.unitId) {
      lockedBatch.totalFeedConsumed = round3(
        Number(lockedBatch.totalFeedConsumed ?? 0) + amountDelta,
      );
      lockedBatch.totalFeedCost = round3(
        Number(lockedBatch.totalFeedCost ?? 0) + correctedCost - previousCost,
      );
      await this.batchMutations.commitBatchTransition(context.mutationSession, {
        intent: 'feeding_corrected',
        aggregate: lockedBatch,
      });
      await this.feedingMutations.incrementDayPlanUnplannedActual(context.mutationSession, {
        dayPlanId: dayPlan.id,
        deltaKg: amountDelta,
      });
      const expectedFcr = Number(dayPlan.resolution.expectedFcr);
      if (!Number.isFinite(expectedFcr) || expectedFcr <= 0) {
        throw new ConflictException('Feeding correction day plan has no positive FCR provenance');
      }
      const movementDate =
        record.feedingDate instanceof Date ? record.feedingDate : new Date(record.feedingDate);
      await this.storageCorrection.apply(context.mutationSession, {
        tenantId: command.tenantId,
        userId: command.actorId,
        feedId: record.feedId,
        deltaKg: amountDelta,
        siteId: context.siteId ?? undefined,
        movementDate,
        sourceDeductionKey: `feeding-deduct-${record.id}`,
        correctionIdempotencyKey: `feeding-correct-${record.id}-${context.operationId}`,
        reference: `FEEDING-CORRECTION: ${record.id}`,
      });
      const growth = await growthScope.applyGrowth(amountDelta / expectedFcr, expectedFcr);
      await this.feedingMutations.recordDayPlanGrowthApplication(context.mutationSession, {
        dayPlanId: dayPlan.id,
        applicationMode: 'UNPLANNED_CORRECTION',
        appliedAt: observedAt,
        expectedFcr,
        feedDeltaKg: amountDelta,
        growthDeltaKg: growth.appliedGrowthKg,
        operationId: context.operationId,
        idempotencyKey: `growth:${dayPlan.id}:unplanned-correction:${context.operationId}`,
        recordedBy: command.actorId,
        sourceRef: `feeding-record:${record.id}`,
      });
      await this.recalcService.recalcForUnit(
        manager,
        context.mutationSession,
        command.tenantId,
        context.unitId,
        'manual_feeding_correction',
        { mutationInstant: growthScope.mutationInstant },
      );
    }

    const event: FeedingRecordUpdatedEvent = {
      ...createBaseEvent<FeedingRecordUpdatedEvent>('FeedingRecordUpdated', command.tenantId, {
        aggregateId: saved.batchId,
        aggregateType: 'Batch',
      }),
      feedingRecordId: saved.id,
      batchId: saved.batchId,
      previousActualAmountKg: previousAmount,
      newActualAmountKg: Number(saved.actualAmount),
      amountDiffKg: amountDelta,
      previousFeedCost: previousCost,
      newFeedCost: Number(saved.feedCost ?? 0),
      costDiff: round3(Number(saved.feedCost ?? 0) - previousCost),
      updatedAt: toEventIso(observedAt),
    };
    await this.outboxPublisher.enqueue(event, manager);
    return projectFeedingRecordOperationResult(saved);
  }
}
