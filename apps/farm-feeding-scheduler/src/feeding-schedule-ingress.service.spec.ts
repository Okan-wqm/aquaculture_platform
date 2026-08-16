import type { MetricsContributorRegistry } from '@aquaculture/backend-common/metrics';
import { CronHeartbeatService } from '@aquaculture/backend-common/metrics';
import { FEEDING_SCHEDULED_JOB_IDS } from '@aquaculture/feeding-contracts';
import * as client from 'prom-client';

import type { FeedingClockPort } from './feeding-clock.port';
import type { FeedingOperationTargetCompilerPort } from './feeding-operation-target-compiler.port';
import type { FeedingScheduleDispatchPort } from './feeding-schedule-dispatch.port';
import { FeedingScheduleIngressService } from './feeding-schedule-ingress.service';
import { FeedingSchedulerTelemetryService } from './feeding-scheduler-telemetry.service';

function partial<T>(value: Partial<T>): T {
  return value as T;
}

describe('FeedingScheduleIngressService durable heartbeat boundary', () => {
  const observedAt = new Date('2026-08-08T12:00:00.000Z');

  function harness(options: { readonly compileFailure?: Error } = {}): {
    readonly service: FeedingScheduleIngressService;
    readonly compileCut: jest.MockedFunction<FeedingOperationTargetCompilerPort['compileCut']>;
    readonly recordSweep: jest.MockedFunction<FeedingSchedulerTelemetryService['recordSweep']>;
    readonly heartbeat: CronHeartbeatService;
  } {
    const compileCut: jest.MockedFunction<FeedingOperationTargetCompilerPort['compileCut']> =
      jest.fn();
    if (options.compileFailure) {
      compileCut.mockRejectedValue(options.compileFailure);
    } else {
      compileCut.mockResolvedValue({
        schemaVersion: 'feeding-scheduler-target-cut/v1',
        observedAt,
        cutDigest: 'a'.repeat(64),
        jobProjections: [...FEEDING_SCHEDULED_JOB_IDS]
          .sort()
          .map((jobId) => ({ jobId, targetCount: 0, targetRoot: 'b'.repeat(64) })),
        tasks: [],
      });
    }
    const compiler: FeedingOperationTargetCompilerPort = { compileCut };
    const dispatch: FeedingScheduleDispatchPort = { enqueue: jest.fn() };
    const clock: FeedingClockPort = { now: () => observedAt };
    const contributor: MetricsContributorRegistry = {
      registerContributor: jest.fn((_name: string, _registry: client.Registry) => undefined),
    };
    const heartbeat = new CronHeartbeatService(contributor);
    const recordSweep: jest.MockedFunction<FeedingSchedulerTelemetryService['recordSweep']> = jest
      .fn()
      .mockResolvedValue(undefined);
    const telemetry = partial<FeedingSchedulerTelemetryService>({ recordSweep });
    const service = new FeedingScheduleIngressService(
      compiler,
      dispatch,
      clock,
      heartbeat,
      telemetry,
    );
    return { service, compileCut, recordSweep, heartbeat };
  }

  it('persists a successful initial sweep before startup can become ready', async () => {
    const { service, recordSweep, heartbeat } = harness();

    await service.onApplicationBootstrap();

    expect(recordSweep).toHaveBeenCalledWith({
      schemaVersion: 'feeding-schedule-sweep-evidence/v1',
      status: 'succeeded',
      observedAt: observedAt.toISOString(),
      stage: 'complete',
      cutDigest: 'a'.repeat(64),
      dueCount: 0,
      dispositions: {
        enqueued: 0,
        idempotent: 0,
        business_slot_preserved: 0,
        already_completed: 0,
        already_running: 0,
        quarantined: 0,
      },
      failureDigests: [],
    });
    await expect(heartbeat.getMetrics()).resolves.toContain(
      'cron_job_runs_total{job="feeding-catalog-reconciler",outcome="success"} 1',
    );
  });

  it('durably records bounded failure evidence and rethrows the sweep failure', async () => {
    const { service, recordSweep, heartbeat } = harness({
      compileFailure: new Error('catalog unavailable'),
    });

    await expect(service.reconcileCatalogSchedule()).rejects.toThrow(
      'Feeding scheduler sweep failed',
    );

    expect(recordSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 'feeding-schedule-sweep-evidence/v1',
        status: 'failed',
        stage: 'compile',
        dueCount: 0,
        failureDigests: [expect.stringMatching(/^[0-9a-f]{64}$/)],
      }),
    );
    await expect(heartbeat.getMetrics()).resolves.toContain(
      'cron_job_runs_total{job="feeding-catalog-reconciler",outcome="failure"} 1',
    );
  });
});
