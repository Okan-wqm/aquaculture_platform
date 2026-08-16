import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { ConflictException, Injectable } from '@nestjs/common';
import { createBaseEvent, type MealUnderfedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import { round3 } from '../../common/utils/rounding.util';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingAggregateMutationPort } from '../feeding-aggregate-mutation.writer';
import {
  DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1,
  DAY_PLAN_GROWTH_APPLICATION_MODE,
} from '../day-plan-growth-reconciliation.authority';
import { type UnitGrowthMutationScopeV1 } from './biomass-growth-applier.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';

export const MEAL_FINALIZATION_POLICY_V1 = Object.freeze({
  schemaVersion: 'meal-finalization/v1',
  defaultUnderfeedThresholdPercent: 15,
  minimumUnderfeedThresholdPercentExclusive: 0,
  maximumUnderfeedThresholdPercentInclusive: 100,
});

export interface FinalizeMealTransitionV1 {
  readonly tenantId: string;
  readonly mutationSession: TenantMutationSession;
  readonly dayPlan: FeedingDayPlan;
  readonly meal: FeedingMeal;
  readonly growthScope: UnitGrowthMutationScopeV1 | null;
  readonly operationId: string;
  readonly finalizedAt: Date;
  readonly fedBy: string | null;
  readonly underfeedThresholdPercent?: number | null;
}

export function resolveUnderfeedThresholdV1(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return MEAL_FINALIZATION_POLICY_V1.defaultUnderfeedThresholdPercent;
  }
  if (
    !Number.isFinite(value) ||
    value <= MEAL_FINALIZATION_POLICY_V1.minimumUnderfeedThresholdPercentExclusive ||
    value > MEAL_FINALIZATION_POLICY_V1.maximumUnderfeedThresholdPercentInclusive
  ) {
    throw new Error('Underfeed threshold must be finite and within (0, 100]');
  }
  return value;
}

/** One decision body for both operator and window-expiry meal closure. */
@Injectable()
export class MealFinalizationAuthority {
  constructor(
    private readonly feedingMutations: FeedingAggregateMutationPort,
    private readonly recalcService: DayPlanRecalcService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async finalize(manager: EntityManager, input: FinalizeMealTransitionV1): Promise<void> {
    const { dayPlan, meal } = input;
    if (
      dayPlan.tenantId !== input.tenantId ||
      meal.tenantId !== input.tenantId ||
      meal.dayPlanId !== dayPlan.id
    ) {
      throw new Error('Meal finalization aggregate identity mismatch');
    }
    if (dayPlan.growthPolicyVersion !== DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion) {
      throw new Error(`Unsupported day-plan growth policy version: ${dayPlan.growthPolicyVersion}`);
    }
    if (
      dayPlan.growthApplicationMode !== DAY_PLAN_GROWTH_APPLICATION_MODE.DAILY &&
      dayPlan.growthApplicationMode !== DAY_PLAN_GROWTH_APPLICATION_MODE.PER_MEAL
    ) {
      throw new Error(`Unsupported day-plan growth mode: ${dayPlan.growthApplicationMode}`);
    }
    if (
      meal.status !== FeedingMealStatus.SCHEDULED &&
      meal.status !== FeedingMealStatus.PARTIALLY_FED
    ) {
      throw new ConflictException(`Meal ${meal.id} cannot finalize from ${meal.status}`);
    }

    const actualKg = Number(meal.actualKg);
    const plannedKg = Number(meal.plannedKg);
    if (
      !Number.isFinite(actualKg) ||
      actualKg <= 0 ||
      !Number.isFinite(plannedKg) ||
      plannedKg < 0
    ) {
      throw new ConflictException(`Meal ${meal.id} has invalid planned/actual quantity`);
    }
    if (!Array.isArray(meal.pours) || meal.pours.length === 0) {
      throw new ConflictException(`Meal ${meal.id} has no durable pour to finalize`);
    }
    const pouredKg = meal.pours.reduce((total, pour, index) => {
      const kg = Number(pour.kg);
      if (pour.pourIndex !== index || !Number.isFinite(kg) || kg <= 0) {
        throw new ConflictException(`Meal ${meal.id} has a malformed pour ledger`);
      }
      return total + kg;
    }, 0);
    if (round3(pouredKg) !== round3(actualKg)) {
      throw new ConflictException(`Meal ${meal.id} actual quantity differs from its pour ledger`);
    }
    meal.status = FeedingMealStatus.FED;
    meal.fedAt = input.finalizedAt;
    if (input.fedBy !== null) meal.fedBy = input.fedBy;
    meal.varianceKg = round3(actualKg - plannedKg);
    meal.variancePercent = plannedKg > 0 ? round3(((actualKg - plannedKg) / plannedKg) * 100) : 0;

    const isPerMeal = dayPlan.growthApplicationMode === DAY_PLAN_GROWTH_APPLICATION_MODE.PER_MEAL;
    const expectedFcr = Number(dayPlan.resolution.expectedFcr);
    if (isPerMeal && actualKg > 0 && (!Number.isFinite(expectedFcr) || expectedFcr <= 0)) {
      throw new ConflictException(`Meal ${meal.id} has no positive live FCR provenance`);
    }
    const growthKg = expectedFcr > 0 ? round3(actualKg / expectedFcr) : 0;
    if (isPerMeal && growthKg !== 0 && !input.growthScope) {
      throw new ConflictException(
        `Meal ${meal.id} cannot finalize without a lockable biomass projection`,
      );
    }

    // Persist FED before recalc so the just-closed meal cannot be selected as a
    // remaining scheduled meal. The surrounding operation transaction keeps
    // growth, projection, events and this write atomic.
    await this.feedingMutations.commitMealTransition(input.mutationSession, {
      intent: 'recorded',
      aggregate: meal,
    });

    if (isPerMeal && input.growthScope && growthKg !== 0) {
      const applied = await input.growthScope.applyGrowth(growthKg, expectedFcr);
      await this.feedingMutations.recordDayPlanGrowthApplication(input.mutationSession, {
        dayPlanId: dayPlan.id,
        applicationMode: 'MEAL_FINALIZATION',
        appliedAt: input.finalizedAt,
        expectedFcr,
        feedDeltaKg: actualKg,
        growthDeltaKg: applied.appliedGrowthKg,
        operationId: input.operationId,
        idempotencyKey: `growth:${dayPlan.id}:meal-finalization:${meal.id}`,
        recordedBy: input.fedBy ?? 'farm-feeding-scheduler',
        sourceRef: `feeding-meal:${meal.id}`,
      });
      await this.recalcService.recalcForUnit(
        manager,
        input.mutationSession,
        input.tenantId,
        meal.unitId,
        'meal_growth',
        { mutationInstant: input.growthScope.mutationInstant },
      );
    }

    const threshold = resolveUnderfeedThresholdV1(input.underfeedThresholdPercent);
    if (meal.variancePercent < -threshold) {
      const event: MealUnderfedEvent = {
        ...createBaseEvent<MealUnderfedEvent>('MealUnderfed', input.tenantId, {
          aggregateId: meal.id,
          aggregateType: 'FeedingMeal',
        }),
        scope: 'meal',
        unitId: meal.unitId,
        unitCode: dayPlan.unitCode,
        dayPlanId: dayPlan.id,
        mealId: meal.id,
        plannedKg,
        actualKg,
        variancePercent: meal.variancePercent,
        thresholdPercent: threshold,
      };
      await this.outboxPublisher.enqueue(event, manager);
    }

    await this.settleDayPlanStatus(manager, input.mutationSession, input.tenantId, dayPlan);
  }

  async settleDayPlanStatus(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    dayPlan: FeedingDayPlan,
  ): Promise<void> {
    const openCount = await manager.count(FeedingMeal, {
      where: [
        { tenantId, dayPlanId: dayPlan.id, status: FeedingMealStatus.SCHEDULED },
        { tenantId, dayPlanId: dayPlan.id, status: FeedingMealStatus.PARTIALLY_FED },
      ],
    });
    const nextStatus =
      openCount === 0 ? FeedingDayPlanStatus.COMPLETED : FeedingDayPlanStatus.IN_PROGRESS;
    if (dayPlan.status === nextStatus) return;
    await this.feedingMutations.commitDayPlanStatusTransition(mutationSession, {
      dayPlanId: dayPlan.id,
      status: nextStatus,
    });
    dayPlan.status = nextStatus;
  }
}
