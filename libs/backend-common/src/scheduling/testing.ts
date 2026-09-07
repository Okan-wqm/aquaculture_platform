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
import type {
  ScheduledJobExecutor,
  ScheduledJobOutcome,
  ScheduledJobScope,
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
