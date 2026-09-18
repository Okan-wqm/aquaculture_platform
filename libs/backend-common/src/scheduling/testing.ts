/**
 * The one test double for `ScheduledJobRunner` (ADMIN-HIGH-013).
 *
 * Every service that adopts `@ScheduledJob` has to provide a runner in its
 * specs, and the obvious thing to write is a pass-through — `run: (_, body) =>
 * body()`. That is enough to keep a suite green and it proves nothing: a
 * pass-through cannot tell a leased job from an unleased one, so a method that
 * kept its schedule and lost its lease looks identical.
 *
 * `createScheduledJobTestExecutor` records what the lease saw and lets a test
 * DENY it, which is what the real runner does when another replica holds the
 * advisory lock. A job whose body still writes under `grant(false)` is a job
 * that would double-fire in production, and that is a thing a test can now say.
 *
 *     const jobs = createScheduledJobTestExecutor();
 *     // …provide { provide: ScheduledJobRunner, useValue: jobs.executor }
 *     jobs.grant(false);
 *     await service.generateMonthlyInvoices();
 *     expect(invoiceRepo.save).not.toHaveBeenCalled();
 *
 * It lives beside the runner rather than in each service's `__tests__` so the
 * denial case is available by default instead of being re-derived — the copies
 * that grow otherwise are all pass-throughs.
 */
import { DynamicModule, Global, Module } from '@nestjs/common';

import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
  type ScheduledJobOutcome,
  type ScheduledJobScope,
} from './scheduled-job-runner.service';

export interface ScheduledJobTestEntry {
  readonly job: string;
  readonly scope: ScheduledJobScope;
}

export interface ScheduledJobTestExecutor {
  /** Provide this for the `ScheduledJobRunner` token. */
  readonly executor: ScheduledJobExecutor;
  /** Every tick that reached the lease, in order. */
  readonly entries: readonly ScheduledJobTestEntry[];
  /** `false` = another replica holds the lock, so the body must not run. */
  grant(allowed: boolean): void;
  /** Forget the recorded ticks and re-grant the lease. */
  reset(): void;
}

export function createScheduledJobTestExecutor(): ScheduledJobTestExecutor {
  const entries: ScheduledJobTestEntry[] = [];
  let allowed = true;

  return {
    entries,
    grant(next: boolean): void {
      allowed = next;
    },
    reset(): void {
      entries.length = 0;
      allowed = true;
    },
    executor: {
      run: async (
        job: string,
        body: () => Promise<void>,
        scope: ScheduledJobScope = 'cluster-single',
      ): Promise<ScheduledJobOutcome> => {
        entries.push({ job, scope });
        if (!allowed) return 'skipped';
        await body();
        return 'ran';
      },
    },
  };
}

/**
 * A `@Global()` stand-in for `ScheduledJobModule`, for DI smoke tests.
 *
 * `ScheduledJobModule` is global in every app, so a service that injects the
 * runner resolves it wherever it lives. A testing module that imports a real
 * feature module has no such global unless it says so — and the failure is
 * `Nest can't resolve dependencies of the X (…, ?)`, which reads like a bug in
 * the module under test rather than a missing global. Importing this alongside
 * the feature module reproduces the app's shape.
 *
 *     Test.createTestingModule({ imports: [AuditModule, ScheduledJobTestModule.forRoot()] })
 *
 * `forRoot` returns a fresh executor per call so two suites cannot share one
 * recording.
 */
@Global()
@Module({})
export class ScheduledJobTestModule {
  static forRoot(
    executor: ScheduledJobTestExecutor = createScheduledJobTestExecutor(),
  ): DynamicModule {
    return {
      module: ScheduledJobTestModule,
      global: true,
      providers: [{ provide: ScheduledJobRunner, useValue: executor.executor }],
      exports: [ScheduledJobRunner],
    };
  }
}
