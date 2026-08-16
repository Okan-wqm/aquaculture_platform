import type { FeedingRecordOperationResult } from '../../feeding-protocol/feeding-operation-command';
import type { FeedingRecord } from '../entities/feeding-record.entity';

/** One projection used by every feeding-record operation result codec boundary. */
export function projectFeedingRecordOperationResult(
  record: FeedingRecord,
): FeedingRecordOperationResult {
  return Object.freeze({
    id: record.id,
    tenantId: record.tenantId,
    batchId: record.batchId,
    tankId: record.tankId,
    pondId: record.pondId,
    batchLocationId: record.batchLocationId,
    feedingDate: record.feedingDate,
    feedingTime: record.feedingTime,
    feedingSequence: record.feedingSequence,
    totalMealsToday: record.totalMealsToday,
    feedId: record.feedId,
    feedBatchNumber: record.feedBatchNumber,
    plannedAmount: record.plannedAmount,
    actualAmount: record.actualAmount,
    variance: record.variance,
    variancePercent: record.variancePercent,
    wasteAmount: record.wasteAmount,
    mealId: record.mealId,
    pourIndex: record.pourIndex,
    dayPlanId: record.dayPlanId,
    environment: record.environment,
    fishBehavior: record.fishBehavior,
    feedingMethod: record.feedingMethod,
    equipmentId: record.equipmentId,
    feedingDurationMinutes: record.feedingDurationMinutes,
    feedCost: record.feedCost,
    feedCostDecimal: record.feedCostDecimal,
    currency: record.currency,
    fedBy: record.fedBy,
    verifiedBy: record.verifiedBy,
    verifiedAt: record.verifiedAt,
    notes: record.notes,
    skipReason: record.skipReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
