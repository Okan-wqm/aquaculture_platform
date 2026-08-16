import { Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';

import { FEEDING_JOB_CATALOG, type FeedingJobId } from '@aquaculture/feeding-contracts';

import { CreateFeedingRecordOperationExecutor } from '../feeding/executors/create-feeding-record-operation.executor';
import { UpdateFeedingRecordOperationExecutor } from '../feeding/executors/update-feeding-record-operation.executor';
import { DayPlanOperationExecutor } from './executors/day-plan-operation.executor';
import { MealOperationExecutor } from './executors/meal-operation.executor';
import { ProtocolFeedForecastExecutor } from './executors/protocol-feed-forecast.executor';
import { ScheduledFeedingOperationExecutor } from './executors/scheduled-feeding-operation.executor';
import type {
  FeedingOperationCommand,
  FeedingOperationCommandFor,
  FeedingOperationCommandResult,
} from './feeding-operation-command';
import type { FeedingOperationHandlerMap } from './feeding-operation-handler';
import {
  feedingDayPlanResultCodec,
  feedingForecastResultCodec,
  feedingMealResultCodec,
  feedingRecordResultCodec,
  feedingVoidResultCodec,
  type FeedingOperationResultCodec,
  type FeedingOperationResultEnvelope,
} from './feeding-operation-result.codec';
import type { FeedingOperationSession } from './feeding-operation-session';

export const FEEDING_OPERATION_HANDLER_ADAPTER = Symbol();

export interface FeedingOperationHandlerAdapterPort {
  execute<K extends FeedingJobId>(
    session: FeedingOperationSession,
    command: FeedingOperationCommandFor<K>,
  ): Promise<FeedingOperationCommandResult<K>>;
  encode<K extends FeedingJobId>(
    jobId: K,
    result: FeedingOperationCommandResult<K>,
  ): FeedingOperationResultEnvelope<K>;
  decode<K extends FeedingJobId>(
    jobId: K,
    schema: string,
    payload: unknown,
  ): FeedingOperationCommandResult<K>;
}

type FeedingOperationRegistrationMap = {
  readonly [K in FeedingJobId]: {
    readonly execute: FeedingOperationHandlerMap[K];
    readonly result: FeedingOperationResultCodec<K>;
  };
};

/**
 * The one bounded adapter between the control-plane kernel and domain code.
 * It is registered under a private, process-local token and never exported by
 * the Nest module. Every catalog identity has exactly one statically wired
 * destination; bootstrap refuses missing, duplicate or foreign identities.
 */
@Injectable()
class FeedingOperationHandlerAdapter
  implements FeedingOperationHandlerAdapterPort, OnApplicationBootstrap
{
  private readonly registrations: FeedingOperationRegistrationMap;

  constructor(
    scheduled: ScheduledFeedingOperationExecutor,
    forecast: ProtocolFeedForecastExecutor,
    dayPlan: DayPlanOperationExecutor,
    record: CreateFeedingRecordOperationExecutor,
    updateRecord: UpdateFeedingRecordOperationExecutor,
    meal: MealOperationExecutor,
  ) {
    this.registrations = Object.freeze({
      'v2.day-plan.generate': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.day-plan.generate'),
      },
      'v2.meal-window.sweep': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.meal-window.sweep'),
      },
      'v2.morning.sweep': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.morning.sweep'),
      },
      'v2.daily-summary.publish': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.daily-summary.publish'),
      },
      'v2.stock-coverage.refresh': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.stock-coverage.refresh'),
      },
      'v2.fcr-alert.sweep': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.fcr-alert.sweep'),
      },
      'v2.retention.purge': {
        execute: (session, command) => scheduled.executeScheduledOperation(session, command),
        result: feedingVoidResultCodec('v2.retention.purge'),
      },
      'v2.forecast.refresh': {
        execute: (session, command) => forecast.executeForecastOperation(session, command),
        result: feedingForecastResultCodec(),
      },
      'manual.day-plan.regenerate': {
        execute: (session, command) => dayPlan.executeRegenerateOperation(session, command),
        result: feedingDayPlanResultCodec('manual.day-plan.regenerate'),
      },
      'manual.feed.transition': {
        execute: (session, command) => dayPlan.executeTransitionOperation(session, command),
        result: feedingDayPlanResultCodec('manual.feed.transition'),
      },
      'manual.feeding.record': {
        execute: (session, command) => record.executeFeedingRecordOperation(session, command),
        result: feedingRecordResultCodec('manual.feeding.record'),
      },
      'manual.feeding.update': {
        execute: (session, command) =>
          updateRecord.executeUpdateFeedingRecordOperation(session, command),
        result: feedingRecordResultCodec('manual.feeding.update'),
      },
      'manual.meal.correct': {
        execute: (session, command) => meal.executeCorrectMealOperation(session, command),
        result: feedingMealResultCodec('manual.meal.correct'),
      },
      'manual.meal.finalize': {
        execute: (session, command) => meal.executeFinalizeMealOperation(session, command),
        result: feedingMealResultCodec('manual.meal.finalize'),
      },
      'manual.meal.skip': {
        execute: (session, command) => meal.executeSkipMealOperation(session, command),
        result: feedingMealResultCodec('manual.meal.skip'),
      },
      'mobile.meal.record': {
        execute: (session, command) => meal.executeRecordMealOperation(session, command),
        result: feedingMealResultCodec('mobile.meal.record'),
      },
    } satisfies FeedingOperationRegistrationMap);
  }

  onApplicationBootstrap(): void {
    const catalogIds = FEEDING_JOB_CATALOG.map((definition) => definition.id).sort();
    const handlerIds = Object.keys(this.registrations).sort();
    if (
      catalogIds.length !== handlerIds.length ||
      catalogIds.some((catalogId, index) => catalogId !== handlerIds[index])
    ) {
      throw new Error(
        `Feeding handler registry differs from catalog: catalog=[${catalogIds.join(',')}], handlers=[${handlerIds.join(',')}]`,
      );
    }
  }

  execute<K extends FeedingOperationCommand['jobId']>(
    session: FeedingOperationSession,
    command: FeedingOperationCommandFor<K>,
  ): Promise<FeedingOperationCommandResult<K>> {
    return this.registrations[command.jobId].execute(session, command);
  }

  encode<K extends FeedingJobId>(
    jobId: K,
    result: FeedingOperationCommandResult<K>,
  ): FeedingOperationResultEnvelope<K> {
    return this.registrations[jobId].result.encode(result);
  }

  decode<K extends FeedingJobId>(
    jobId: K,
    schema: string,
    payload: unknown,
  ): FeedingOperationCommandResult<K> {
    const expectedSchema = `feeding-operation-result/${jobId}/v1`;
    if (schema !== expectedSchema) {
      throw new TypeError(`Persisted feeding result schema ${schema} is not ${expectedSchema}`);
    }
    return this.registrations[jobId].result.decode(payload);
  }
}

export const FEEDING_OPERATION_HANDLER_ADAPTER_PROVIDER: Provider = {
  provide: FEEDING_OPERATION_HANDLER_ADAPTER,
  useClass: FeedingOperationHandlerAdapter,
};
