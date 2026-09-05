/**
 * `@ScheduledJob()` — the only way a method is scheduled (ADMIN-HIGH-013).
 *
 * It replaces a bare `@Cron(...)` / `@Interval(...)`: it applies the NestJS
 * schedule decorator itself and wraps the body so every tick goes through
 * `ScheduledJobRunner.run` — the advisory-lock lease and the heartbeat —
 * with nothing for the author to remember. Adopting the schedule therefore
 * adopts the lease and the heartbeat; there is no way to have one without
 * the others.
 *
 * The class must expose the runner as `scheduledJobs` (constructor-injected
 * `ScheduledJobRunner`). That is a compile-time requirement: the decorator's
 * `target` is constrained to `HasScheduledJobRunner`, so a class without the
 * member does not build. The method takes no arguments and returns
 * `Promise<void>` — a scheduled tick has no caller to hand it anything.
 *
 *   @ScheduledJob({ name: 'announcements.expire', cron: CronExpression.EVERY_HOUR })
 *   async expireAnnouncements(): Promise<void> { ...unchanged body... }
 *
 * `scope: 'each-replica'` is for per-process housekeeping (an in-memory
 * cache sweep) that every replica must run; it skips the lock, never the
 * heartbeat.
 */
import { Cron, Interval } from '@nestjs/schedule';

import { registerScheduledJobName } from './scheduled-job.registry';
import type { ScheduledJobExecutor, ScheduledJobScope } from './scheduled-job-runner.service';

export interface HasScheduledJobRunner {
  readonly scheduledJobs: ScheduledJobExecutor;
}

export type ScheduledJobMethod = () => Promise<void>;

interface ScheduledJobBaseOptions {
  /** Heartbeat series + lock key. Lower-case words joined by '-' or '.'; unique per service. */
  readonly name: string;
  readonly scope?: ScheduledJobScope;
}

export type ScheduledJobOptions =
  | (ScheduledJobBaseOptions & { readonly cron: string; readonly every?: never })
  | (ScheduledJobBaseOptions & { readonly every: number; readonly cron?: never });

export function ScheduledJob(options: ScheduledJobOptions) {
  return function decorate<T extends HasScheduledJobRunner>(
    target: T,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<ScheduledJobMethod>,
  ): void {
    const owner = `${target.constructor.name}#${String(propertyKey)}`;
    registerScheduledJobName(options.name, owner);
    const original = descriptor.value;
    if (typeof original !== 'function') {
      throw new Error(`@ScheduledJob on ${owner}: not a method`);
    }
    const scope: ScheduledJobScope = options.scope ?? 'cluster-single';
    const wrapped = async function scheduledTick(this: HasScheduledJobRunner): Promise<void> {
      await this.scheduledJobs.run(options.name, () => original.call(this), scope);
    };
    Object.defineProperty(wrapped, 'name', { value: String(propertyKey) });
    descriptor.value = wrapped;
    // The NestJS decorator reads metadata off `descriptor.value`, so it must
    // see the wrapper: the scheduler then invokes the leased, heartbeated tick.
    const schedule = options.cron !== undefined ? Cron(options.cron) : Interval(options.every);
    schedule(target, propertyKey, descriptor);
  };
}
