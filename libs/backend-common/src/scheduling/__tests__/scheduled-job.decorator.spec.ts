import 'reflect-metadata';

import {
  SCHEDULE_CRON_OPTIONS,
  SCHEDULE_INTERVAL_OPTIONS,
} from '@nestjs/schedule/dist/schedule.constants';

import { ScheduledJob } from '../scheduled-job.decorator';
import type {
  ScheduledJobExecutor,
  ScheduledJobOutcome,
  ScheduledJobScope,
} from '../scheduled-job-runner.service';
import { clearScheduledJobRegistry, registeredScheduledJobNames } from '../scheduled-job.registry';

/**
 * ADMIN-HIGH-013 — the decorator is the schedule, the lease and the
 * heartbeat in one: it applies the NestJS schedule metadata itself and
 * routes the body through the class's `scheduledJobs` runner.
 */
class RecordingExecutor implements ScheduledJobExecutor {
  readonly calls: Array<{ job: string; scope: ScheduledJobScope | undefined }> = [];

  async run(
    job: string,
    body: () => Promise<void>,
    scope?: ScheduledJobScope,
  ): Promise<ScheduledJobOutcome> {
    this.calls.push({ job, scope });
    await body();
    return 'ran';
  }
}

describe('@ScheduledJob', () => {
  afterEach(() => clearScheduledJobRegistry());

  it('wraps the body in the runner and carries the NestJS cron metadata on the wrapper', async () => {
    class Sweeper {
      readonly ran: string[] = [];

      constructor(readonly scheduledJobs: RecordingExecutor) {}

      @ScheduledJob({ name: 'sweeper.hourly', cron: '0 * * * *' })
      async hourly(): Promise<void> {
        this.ran.push('hourly');
      }
    }
    const executor = new RecordingExecutor();
    const sweeper = new Sweeper(executor);

    await sweeper.hourly();

    expect(sweeper.ran).toEqual(['hourly']);
    expect(executor.calls).toEqual([{ job: 'sweeper.hourly', scope: 'cluster-single' }]);
    expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, sweeper.hourly)).toMatchObject({
      cronTime: '0 * * * *',
    });
    expect(registeredScheduledJobNames()).toEqual(['sweeper.hourly']);
  });

  it('applies interval metadata and passes an each-replica scope through', async () => {
    class Cache {
      constructor(readonly scheduledJobs: RecordingExecutor) {}

      @ScheduledJob({ name: 'cache.sweep', every: 30_000, scope: 'each-replica' })
      async sweep(): Promise<void> {}
    }
    const executor = new RecordingExecutor();
    const cache = new Cache(executor);

    await cache.sweep();

    expect(executor.calls).toEqual([{ job: 'cache.sweep', scope: 'each-replica' }]);
    expect(Reflect.getMetadata(SCHEDULE_INTERVAL_OPTIONS, cache.sweep)).toEqual({
      timeout: 30_000,
    });
  });

  it('refuses a second method with the same name and a name that is not a job name', () => {
    expect(() => {
      class A {
        constructor(readonly scheduledJobs: RecordingExecutor) {}

        @ScheduledJob({ name: 'dup.job', every: 1_000 })
        async one(): Promise<void> {}
      }
      class B {
        constructor(readonly scheduledJobs: RecordingExecutor) {}

        @ScheduledJob({ name: 'dup.job', every: 1_000 })
        async two(): Promise<void> {}
      }
      return [A, B];
    }).toThrow(/declared by both A#one and B#two/);

    expect(() => {
      class C {
        constructor(readonly scheduledJobs: RecordingExecutor) {}

        @ScheduledJob({ name: 'Not A Name', every: 1_000 })
        async run(): Promise<void> {}
      }
      return C;
    }).toThrow(/must be lower-case words/);
  });
});
