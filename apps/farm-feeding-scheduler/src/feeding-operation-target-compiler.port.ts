import type {
  FeedingSchedulerCutV1,
  FeedingTimezone,
  ScheduledFeedingJobId,
} from '@aquaculture/feeding-contracts';

export const FEEDING_OPERATION_TARGET_COMPILER_PORT = Symbol(
  'FEEDING_OPERATION_TARGET_COMPILER_PORT',
);

export type CompiledFeedingOperationTarget =
  | {
      readonly tenantId: string;
      readonly targetKind: 'site';
      readonly targetId: string;
      readonly timezone: FeedingTimezone;
      readonly schedulerCut: FeedingSchedulerCutV1;
    }
  | {
      readonly tenantId: string;
      readonly targetKind: 'tenant';
      readonly targetId: null;
      readonly timezone: FeedingTimezone;
      readonly schedulerCut: FeedingSchedulerCutV1;
    };

export interface CompiledFeedingOperationTask {
  readonly jobId: ScheduledFeedingJobId;
  readonly target: CompiledFeedingOperationTarget;
}

export interface CompiledFeedingSchedulerJobProjection {
  readonly jobId: ScheduledFeedingJobId;
  readonly targetCount: number;
  readonly targetRoot: string;
}

export interface CompiledFeedingSchedulerCut {
  readonly schemaVersion: 'feeding-scheduler-target-cut/v1';
  readonly observedAt: Date;
  readonly cutDigest: string;
  readonly jobProjections: readonly CompiledFeedingSchedulerJobProjection[];
  readonly tasks: readonly CompiledFeedingOperationTask[];
}

export interface FeedingOperationTargetCompilerPort {
  compileCut(observedAt: Date): Promise<CompiledFeedingSchedulerCut>;
}
