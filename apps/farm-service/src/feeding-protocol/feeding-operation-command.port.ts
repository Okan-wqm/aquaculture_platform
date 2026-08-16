import type {
  CorrectMealOperationCommand,
  FinalizeMealOperationCommand,
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

type CommandBody<T extends { readonly jobId: string }> = Omit<T, 'jobId'>;

/** Process-local DI identity exported by the composition root. */
export const FEEDING_OPERATION_COMMAND_PORT = Symbol('FEEDING_OPERATION_COMMAND_PORT');

export interface FeedingReconciliationResult {
  readonly status: 'executed' | 'replayed' | 'leased' | 'not_due';
  readonly operationId?: string;
}

/**
 * Closed ingress surface. Each method owns its job identity, so presentation
 * providers cannot select a different capability, handler, or schedule class.
 */
export interface FeedingOperationCommandPort {
  refreshForecast(
    command: CommandBody<ForecastRefreshOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'v2.forecast.refresh'>>;
  regenerateDayPlan(
    command: CommandBody<RegenerateDayPlanOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.day-plan.regenerate'>>;
  transitionFeed(
    command: CommandBody<TransitionFeedOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.feed.transition'>>;
  recordFeeding(
    command: CommandBody<ManualFeedingRecordOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.feeding.record'>>;
  updateFeeding(
    command: CommandBody<UpdateFeedingRecordOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.feeding.update'>>;
  correctMeal(
    command: CommandBody<CorrectMealOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.meal.correct'>>;
  finalizeMeal(
    command: CommandBody<FinalizeMealOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.meal.finalize'>>;
  skipMeal(
    command: CommandBody<SkipMealOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'manual.meal.skip'>>;
  recordMeal(
    command: CommandBody<RecordMealOperationCommand>,
  ): Promise<FeedingOperationCommandResult<'mobile.meal.record'>>;
  reconcileScheduled(
    command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
  ): Promise<FeedingReconciliationResult>;
}
