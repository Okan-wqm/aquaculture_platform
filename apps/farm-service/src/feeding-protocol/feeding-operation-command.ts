import type { RequiredMobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import type { Role } from '@aquaculture/backend-common/decorators';
import type {
  FeedingJobId,
  FeedingMethodValue,
  FeedingRecordEnvironment,
  FeedingRecordFishBehavior,
  SiteScheduledFeedingJobId,
  TenantScheduledFeedingJobId,
  FeedingTimezoneSource,
  FeedingSchedulerCutV1,
  FeedingDueOccurrence,
} from '@aquaculture/feeding-contracts';

export type FeedingRecordEnvironmentInput = FeedingRecordEnvironment;
export type FeedingRecordFishBehaviorInput = FeedingRecordFishBehavior;

export interface ManualFeedingRecordPayload {
  readonly batchId: string;
  readonly tankId?: string;
  readonly pondId?: string;
  readonly batchLocationId?: string;
  readonly feedingDate: Date;
  readonly feedingTime: string;
  readonly feedingSequence?: number;
  readonly totalMealsToday?: number;
  readonly feedId: string;
  readonly feedBatchNumber?: string;
  readonly plannedAmount: number;
  readonly actualAmount: number;
  readonly wasteAmount?: number;
  readonly environment?: FeedingRecordEnvironmentInput;
  readonly fishBehavior?: FeedingRecordFishBehaviorInput;
  readonly feedingMethod?: FeedingMethodValue;
  readonly equipmentId?: string;
  readonly feedingDurationMinutes?: number;
  readonly feedCost?: number;
  readonly currency?: string;
  readonly fedBy: string;
  readonly notes?: string;
  readonly skipReason?: string;
}

export interface DayPlanOperationResult {
  readonly outcome: 'recalculated' | 'generated' | 'transitioned';
  readonly dayPlanId?: string;
}

export interface MealOperationResult {
  readonly id: string;
  readonly status: 'scheduled' | 'fed' | 'partially_fed' | 'skipped' | 'missed' | 'cancelled';
  readonly actualKg: number;
  readonly varianceKg: number | null;
  readonly variancePercent: number | null;
}

export interface FeedingRecordOperationResult {
  readonly id: string;
  readonly tenantId: string;
  readonly batchId: string;
  readonly tankId?: string;
  readonly pondId?: string;
  readonly batchLocationId?: string;
  readonly feedingDate: Date;
  readonly feedingTime: string;
  readonly feedingSequence: number;
  readonly totalMealsToday: number;
  readonly feedId: string;
  readonly feedBatchNumber?: string;
  readonly plannedAmount: number;
  readonly actualAmount: number;
  readonly variance: number;
  readonly variancePercent: number;
  readonly wasteAmount?: number;
  readonly mealId?: string;
  readonly pourIndex?: number;
  readonly dayPlanId?: string;
  readonly environment?: FeedingRecordEnvironmentInput;
  readonly fishBehavior?: FeedingRecordFishBehaviorInput;
  readonly feedingMethod: FeedingMethodValue;
  readonly equipmentId?: string;
  readonly feedingDurationMinutes?: number;
  readonly feedCost?: number;
  readonly feedCostDecimal: number | null;
  readonly currency?: string;
  readonly fedBy: string;
  readonly verifiedBy?: string;
  readonly verifiedAt?: Date;
  readonly notes?: string;
  readonly skipReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FeedingOperationActor {
  readonly actorId: string;
  readonly requestId: string;
}

export interface FeedingOperationCaller {
  readonly sub: string;
  readonly roles: readonly Role[];
  readonly assignedSiteIds?: readonly string[];
}

/** Immutable authority cut compiled once for one scheduler observation. */
export type FeedingSchedulerCut = FeedingSchedulerCutV1;

export interface ScheduledSiteFeedingOperationCommand {
  readonly jobId: SiteScheduledFeedingJobId;
  readonly tenantId: string;
  readonly siteId: string;
  readonly schedulerCut: FeedingSchedulerCut;
  readonly occurrence: FeedingDueOccurrence;
  readonly dispatchDigest: string;
}

export interface ScheduledTenantFeedingOperationCommand {
  readonly jobId: TenantScheduledFeedingJobId;
  readonly tenantId: string;
  readonly schedulerCut: FeedingSchedulerCut;
  readonly occurrence: FeedingDueOccurrence;
  readonly dispatchDigest: string;
}

export interface ForecastRefreshOperationCommand extends FeedingOperationActor {
  readonly jobId: 'v2.forecast.refresh';
  readonly tenantId: string;
  readonly siteId: string;
  readonly emitCoverageEvents: boolean;
}

export interface RegenerateDayPlanOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.day-plan.regenerate';
  readonly tenantId: string;
  readonly unitId: string;
}

export interface TransitionFeedOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.feed.transition';
  readonly tenantId: string;
  readonly unitId: string;
  readonly toFeedId: string;
}

export interface ManualFeedingRecordOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.feeding.record';
  readonly tenantId: string;
  readonly payload: ManualFeedingRecordPayload;
}

export interface UpdateFeedingRecordPayload {
  readonly actualAmount?: number;
  readonly wasteAmount?: number;
  readonly environment?: FeedingRecordEnvironmentInput;
  readonly fishBehavior?: FeedingRecordFishBehaviorInput;
  readonly notes?: string;
  readonly verifiedBy?: string;
}

export interface UpdateFeedingRecordOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.feeding.update';
  readonly tenantId: string;
  readonly feedingRecordId: string;
  readonly payload: UpdateFeedingRecordPayload;
}

export interface CorrectMealOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.meal.correct';
  readonly tenantId: string;
  readonly caller: FeedingOperationCaller;
  readonly mealId: string;
  readonly pourIndex: number;
  readonly correctedKg: number;
}

export interface SkipMealOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.meal.skip';
  readonly tenantId: string;
  readonly caller: FeedingOperationCaller;
  readonly mealId: string;
  readonly reason: string;
}

export interface FinalizeMealOperationCommand extends FeedingOperationActor {
  readonly jobId: 'manual.meal.finalize';
  readonly tenantId: string;
  readonly caller: FeedingOperationCaller;
  readonly mealId: string;
}

export interface RecordMealOperationCommand extends FeedingOperationActor {
  readonly jobId: 'mobile.meal.record';
  readonly tenantId: string;
  readonly caller: FeedingOperationCaller;
  readonly mealId: string;
  readonly pourKg: number;
  readonly finalize: boolean;
  readonly feedingMethod?: FeedingMethodValue;
  readonly notes?: string;
  readonly envelope: RequiredMobileCommandEnvelope;
}

export type FeedingOperationCommand =
  | ScheduledSiteFeedingOperationCommand
  | ScheduledTenantFeedingOperationCommand
  | ForecastRefreshOperationCommand
  | RegenerateDayPlanOperationCommand
  | TransitionFeedOperationCommand
  | ManualFeedingRecordOperationCommand
  | UpdateFeedingRecordOperationCommand
  | CorrectMealOperationCommand
  | FinalizeMealOperationCommand
  | SkipMealOperationCommand
  | RecordMealOperationCommand;

export interface FeedingOperationResultByJob {
  readonly 'v2.day-plan.generate': void;
  readonly 'v2.meal-window.sweep': void;
  readonly 'v2.morning.sweep': void;
  readonly 'v2.daily-summary.publish': void;
  readonly 'v2.stock-coverage.refresh': void;
  readonly 'v2.fcr-alert.sweep': void;
  readonly 'v2.retention.purge': void;
  readonly 'v2.forecast.refresh': number;
  readonly 'manual.day-plan.regenerate': DayPlanOperationResult;
  readonly 'manual.feed.transition': DayPlanOperationResult;
  readonly 'manual.feeding.record': FeedingRecordOperationResult;
  readonly 'manual.feeding.update': FeedingRecordOperationResult;
  readonly 'manual.meal.correct': MealOperationResult;
  readonly 'manual.meal.finalize': MealOperationResult;
  readonly 'manual.meal.skip': MealOperationResult;
  readonly 'mobile.meal.record': MealOperationResult;
}

type MissingCommandResult = Exclude<FeedingJobId, keyof FeedingOperationResultByJob>;
type UnknownCommandResult = Exclude<keyof FeedingOperationResultByJob, FeedingJobId>;
export type FeedingOperationCommandResultAuthority = [
  MissingCommandResult,
  UnknownCommandResult,
] extends [never, never]
  ? FeedingOperationResultByJob
  : never;

export type FeedingOperationCommandFor<K extends FeedingJobId> = Extract<
  FeedingOperationCommand,
  { readonly jobId: K }
>;

export type FeedingOperationCommandResult<K extends FeedingJobId> =
  FeedingOperationCommandResultAuthority[K];
