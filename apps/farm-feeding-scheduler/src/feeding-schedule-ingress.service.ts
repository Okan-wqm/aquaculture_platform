import {
  FEEDING_SCHEDULER_READY_SIGNAL,
  emitBootInvariantSignal,
} from '@aquaculture/backend-common/constants';
import { StructuredLoggerService } from '@aquaculture/backend-common/logging';
import { CronHeartbeatService } from '@aquaculture/backend-common/metrics';
import {
  FEEDING_SCHEDULER_OBSERVABILITY_V1,
  FEEDING_SCHEDULER_TRIGGER,
  FEEDING_SCHEDULED_JOB_IDS,
  type FeedingScheduledDispatchEnvelopeV1,
  createFeedingScheduledDispatchEnvelope,
  feedingDueOccurrences,
  feedingJobDefinition,
} from '@aquaculture/feeding-contracts';
import { canonicalWireJsonSha256V1 } from '@aquaculture/shared-contracts';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { FEEDING_CLOCK_PORT, type FeedingClockPort } from './feeding-clock.port';
import {
  FEEDING_OPERATION_TARGET_COMPILER_PORT,
  type CompiledFeedingOperationTask,
  type FeedingOperationTargetCompilerPort,
} from './feeding-operation-target-compiler.port';
import {
  FEEDING_SCHEDULE_DISPATCH_PORT,
  type FeedingScheduleDispatchPort,
} from './feeding-schedule-dispatch.port';
import { FeedingSchedulerTelemetryService } from './feeding-scheduler-telemetry.service';

const FEEDING_SCHEDULER_MAX_CONCURRENCY = 4;

export interface FeedingScheduleSweepEvidenceV1 {
  readonly schemaVersion: 'feeding-schedule-sweep-evidence/v1';
  readonly status: 'succeeded' | 'failed';
  readonly observedAt: string;
  readonly stage: 'compile' | 'dispatch_projection' | 'enqueue' | 'complete';
  readonly cutDigest: string | null;
  readonly dueCount: number;
  readonly dispositions: Readonly<
    Record<(typeof FEEDING_SCHEDULER_OBSERVABILITY_V1.dispositionKeys)[number], number>
  >;
  readonly failureDigests: readonly string[];
}

class FeedingScheduleSweepError extends Error {
  constructor(readonly evidence: FeedingScheduleSweepEvidenceV1) {
    super('Feeding scheduler sweep failed; inspect structured sweep evidence');
    this.name = 'FeedingScheduleSweepError';
  }
}

@Injectable()
export class FeedingScheduleIngressService implements OnApplicationBootstrap {
  private readonly logger = new StructuredLoggerService('farm-feeding-scheduler');
  private sweepInFlight: Promise<void> | undefined;
  private lastSweepEvidence: FeedingScheduleSweepEvidenceV1 | undefined;

  constructor(
    @Inject(FEEDING_OPERATION_TARGET_COMPILER_PORT)
    private readonly targetCompiler: FeedingOperationTargetCompilerPort,
    @Inject(FEEDING_SCHEDULE_DISPATCH_PORT)
    private readonly dispatchPort: FeedingScheduleDispatchPort,
    @Inject(FEEDING_CLOCK_PORT)
    private readonly clock: FeedingClockPort,
    private readonly heartbeat: CronHeartbeatService,
    private readonly telemetry: FeedingSchedulerTelemetryService,
  ) {
    this.heartbeat.declare(FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcileCatalogSchedule();
    emitBootInvariantSignal(this.logger, FEEDING_SCHEDULER_READY_SIGNAL, {
      schedulerJob: FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob,
      durableHeartbeat: true,
    });
  }

  @Cron(FEEDING_SCHEDULER_TRIGGER.schedule, { name: FEEDING_SCHEDULER_TRIGGER.name })
  reconcileCatalogSchedule(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const sweep = this.heartbeat
      .track(FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob, async () => {
        const evidence = await this.runCatalogSweep(this.clock.now());
        await this.telemetry.recordSweep(evidence);
        if (evidence.status === 'failed') throw new FeedingScheduleSweepError(evidence);
      })
      .finally(() => {
        if (this.sweepInFlight === sweep) this.sweepInFlight = undefined;
      });
    this.sweepInFlight = sweep;
    return sweep;
  }

  getLastSweepEvidence(): FeedingScheduleSweepEvidenceV1 | undefined {
    return this.lastSweepEvidence;
  }

  private async runCatalogSweep(observedAt: Date): Promise<FeedingScheduleSweepEvidenceV1> {
    let stage: FeedingScheduleSweepEvidenceV1['stage'] = 'compile';
    let cutDigest: string | null = null;
    let dueCount = 0;
    const dispositions: Record<
      (typeof FEEDING_SCHEDULER_OBSERVABILITY_V1.dispositionKeys)[number],
      number
    > = {
      enqueued: 0,
      idempotent: 0,
      business_slot_preserved: 0,
      already_completed: 0,
      already_running: 0,
      quarantined: 0,
    };
    const failureDigests: string[] = [];
    try {
      const cut = await this.targetCompiler.compileCut(observedAt);
      const expectedProjectionJobs = [...FEEDING_SCHEDULED_JOB_IDS].sort();
      if (
        cut.schemaVersion !== 'feeding-scheduler-target-cut/v1' ||
        cut.observedAt.toISOString() !== observedAt.toISOString() ||
        !/^[0-9a-f]{64}$/.test(cut.cutDigest) ||
        cut.jobProjections.length !== expectedProjectionJobs.length ||
        cut.jobProjections.some(
          (projection, index) => projection.jobId !== expectedProjectionJobs[index],
        ) ||
        cut.jobProjections.reduce((sum, projection) => sum + projection.targetCount, 0) !==
          cut.tasks.length
      ) {
        throw new Error('Feeding target compiler returned a different scheduler cut');
      }
      cutDigest = cut.cutDigest;
      stage = 'dispatch_projection';
      const due = cut.tasks.flatMap((task) => this.dispatchesFor(task));
      dueCount = due.length;
      stage = 'enqueue';
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(FEEDING_SCHEDULER_MAX_CONCURRENCY, due.length) },
        async () => {
          while (cursor < due.length) {
            const envelope = due[cursor++];
            if (!envelope) return;
            try {
              const result = await this.dispatchPort.enqueue(envelope);
              dispositions[result.disposition] += 1;
            } catch (error: unknown) {
              failureDigests.push(this.failureDigest(stage, error, envelope.dispatchDigest));
            }
          }
        },
      );
      await Promise.all(workers);
      if (failureDigests.length > 0) {
        return this.failSweep(observedAt, stage, cutDigest, dueCount, dispositions, failureDigests);
      }
      this.lastSweepEvidence = Object.freeze({
        schemaVersion: 'feeding-schedule-sweep-evidence/v1',
        status: 'succeeded',
        stage: 'complete',
        observedAt: observedAt.toISOString(),
        cutDigest,
        dueCount,
        dispositions: Object.freeze({ ...dispositions }),
        failureDigests: Object.freeze([]),
      });
      return this.lastSweepEvidence;
    } catch (error: unknown) {
      return this.failSweep(observedAt, stage, cutDigest, dueCount, dispositions, [
        this.failureDigest(stage, error),
      ]);
    }
  }

  private failureDigest(
    stage: FeedingScheduleSweepEvidenceV1['stage'],
    error: unknown,
    dispatchDigest?: string,
  ): string {
    let errorText = 'uninspectable-error';
    try {
      errorText = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    } catch {
      errorText = 'uninspectable-error';
    }
    errorText = errorText.replace(/[\uD800-\uDFFF]/gu, '\uFFFD').slice(0, 1_024);
    return canonicalWireJsonSha256V1(
      {
        domain: 'aquaculture.feeding-schedule-sweep-failure',
        schemaVersion: 'feeding-schedule-sweep-failure/v1',
      },
      { stage, dispatchDigest: dispatchDigest ?? null, errorText },
    );
  }

  private failSweep(
    observedAt: Date,
    stage: FeedingScheduleSweepEvidenceV1['stage'],
    cutDigest: string | null,
    dueCount: number,
    dispositions: FeedingScheduleSweepEvidenceV1['dispositions'],
    failureDigests: readonly string[],
  ): FeedingScheduleSweepEvidenceV1 {
    const evidence: FeedingScheduleSweepEvidenceV1 = Object.freeze({
      schemaVersion: 'feeding-schedule-sweep-evidence/v1',
      status: 'failed',
      stage,
      observedAt: observedAt.toISOString(),
      cutDigest,
      dueCount,
      dispositions: Object.freeze({ ...dispositions }),
      failureDigests: Object.freeze([...failureDigests].sort()),
    });
    this.lastSweepEvidence = evidence;
    this.logger.error(
      'Feeding scheduler sweep failed',
      {
        stage,
        cutDigest,
        dueCount,
        failureCount: evidence.failureDigests.length,
        failureDigests: evidence.failureDigests,
      },
      FeedingScheduleIngressService.name,
    );
    return evidence;
  }

  private dispatchesFor(task: CompiledFeedingOperationTask): FeedingScheduledDispatchEnvelopeV1[] {
    const definition = feedingJobDefinition(task.jobId);
    if (
      task.target.schedulerCut.cutDigest.length !== 64 ||
      task.target.schedulerCut.timezone !== task.target.timezone ||
      task.target.schedulerCut.timezoneSource !== definition.timezoneSource ||
      definition.targetCardinality !== task.target.targetKind
    ) {
      throw new Error(`Compiled feeding target disagrees with catalog job ${task.jobId}`);
    }
    return feedingDueOccurrences(
      definition,
      task.target.schedulerCut.observedAt,
      task.target.timezone,
    ).map((occurrence) =>
      createFeedingScheduledDispatchEnvelope({
        jobId: task.jobId,
        tenantId: task.target.tenantId,
        target:
          task.target.targetKind === 'tenant'
            ? { targetKind: 'tenant', targetId: null }
            : { targetKind: 'site', targetId: task.target.targetId },
        cut: task.target.schedulerCut,
        occurrence,
      }),
    );
  }
}
