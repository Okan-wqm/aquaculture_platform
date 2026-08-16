import type { FeedingJobId } from '@aquaculture/feeding-contracts';

import type {
  CorrectMealOperationCommand,
  FinalizeMealOperationCommand,
  FeedingOperationCommand,
  FeedingOperationCommandFor,
  FeedingOperationCommandResult,
  ForecastRefreshOperationCommand,
  ManualFeedingRecordOperationCommand,
  UpdateFeedingRecordOperationCommand,
  RecordMealOperationCommand,
  RegenerateDayPlanOperationCommand,
  ScheduledSiteFeedingOperationCommand,
  ScheduledTenantFeedingOperationCommand,
  SkipMealOperationCommand,
  TransitionFeedOperationCommand,
} from './feeding-operation-command';
import type { FeedingOperationSession } from './feeding-operation-session';

export interface FeedingScheduledOperationHandler {
  executeScheduledOperation(
    session: FeedingOperationSession,
    command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
  ): Promise<void>;
}

export interface FeedingForecastOperationHandler {
  executeForecastOperation(
    session: FeedingOperationSession,
    command: ForecastRefreshOperationCommand,
  ): Promise<number>;
}

export interface FeedingDayPlanOperationHandler {
  executeRegenerateOperation(
    session: FeedingOperationSession,
    command: RegenerateDayPlanOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.day-plan.regenerate'>>;
  executeTransitionOperation(
    session: FeedingOperationSession,
    command: TransitionFeedOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.feed.transition'>>;
}

export interface FeedingRecordCreateOperationHandler {
  executeFeedingRecordOperation(
    session: FeedingOperationSession,
    command: ManualFeedingRecordOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.feeding.record'>>;
}

export interface FeedingRecordUpdateOperationHandler {
  executeUpdateFeedingRecordOperation(
    session: FeedingOperationSession,
    command: UpdateFeedingRecordOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.feeding.update'>>;
}

export interface FeedingMealOperationHandler {
  executeRecordMealOperation(
    session: FeedingOperationSession,
    command: RecordMealOperationCommand,
  ): Promise<FeedingOperationCommandResult<'mobile.meal.record'>>;
  executeCorrectMealOperation(
    session: FeedingOperationSession,
    command: CorrectMealOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.meal.correct'>>;
  executeFinalizeMealOperation(
    session: FeedingOperationSession,
    command: FinalizeMealOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.meal.finalize'>>;
  executeSkipMealOperation(
    session: FeedingOperationSession,
    command: SkipMealOperationCommand,
  ): Promise<FeedingOperationCommandResult<'manual.meal.skip'>>;
}

export type FeedingOperationHandlerMap = {
  readonly [K in FeedingJobId]: (
    session: FeedingOperationSession,
    command: FeedingOperationCommandFor<K>,
  ) => Promise<FeedingOperationCommandResult<K>>;
};

export type FeedingOperationHandler = FeedingOperationHandlerMap[FeedingOperationCommand['jobId']];
