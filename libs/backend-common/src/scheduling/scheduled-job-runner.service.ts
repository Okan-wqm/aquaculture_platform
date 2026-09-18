/**
 * ScheduledJobRunner — one replica runs a scheduled tick, and every tick is
 * heartbeated (ADMIN-HIGH-013).
 *
 * WHY: `@Cron` / `@Interval` fire on every replica of a service. With two
 * admin-api pods, every sweep ran twice: two provisioning queue drainers
 * racing for the same run, two SLA checkers raising the same breach, two
 * job-queue processors executing the same background job. Nothing recorded
 * that a tick happened, so a scheduler that silently stopped looked like a
 * scheduler with nothing to do.
 *
 * WHAT: `run(job, body)` takes a Postgres transaction-scoped advisory lock
 * keyed on (service, job) — `pg_try_advisory_xact_lock(hashtext(service),
 * hashtext(job))` — and runs the body only when it wins. The lock lives
 * exactly as long as the transaction that holds it, so a crashed replica
 * releases it with its connection; there is no lease row to expire and no
 * clock to trust. Winning ticks go through `CronHeartbeatService.track`, so
 * the `cron_job_*` series (and the CronJobNeverRan / CronJobFailingEveryRun
 * rules) cover every scheduled job by construction. Losing ticks count as
 * `skipped` — a replica that never wins is visible, a job that is never
 * attempted anywhere is visible.
 *
 * A job whose work is per-process (an in-memory cache sweep) declares
 * `scope: 'each-replica'` and skips the lock, never the heartbeat.
 *
 * ADOPTION is the `@ScheduledJob()` decorator, which is the only sanctioned
 * way to schedule a method: it applies the NestJS schedule decorator itself
 * and routes the body through this runner, and it will not compile on a
 * class that has no `scheduledJobs: ScheduledJobExecutor` member.
 * `tests/invariants/scheduled-jobs-leased.spec.ts` keeps raw scheduler
 * decorators out of the fleet.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { queryRowsNormalized } from '../database/query-result-normalizer';
import { CronHeartbeatService } from '../metrics/cron-heartbeat.service';

import { registeredScheduledJobNames } from './scheduled-job.registry';

export const SCHEDULED_JOB_OPTIONS = Symbol('SCHEDULED_JOB_OPTIONS');

export interface ScheduledJobModuleOptions {
  /** Lock namespace — one service's jobs never contend with another's on a shared database. */
  readonly serviceName: string;
}

/** `cluster-single`: one replica per tick (default). `each-replica`: per-process housekeeping. */
export type ScheduledJobScope = 'cluster-single' | 'each-replica';

export type ScheduledJobOutcome = 'ran' | 'skipped';

/** The port a scheduled method depends on; the class carrying `@ScheduledJob` must expose it as `scheduledJobs`. */
export interface ScheduledJobExecutor {
  run(
    job: string,
    body: () => Promise<void>,
    scope?: ScheduledJobScope,
  ): Promise<ScheduledJobOutcome>;
}

/** The slice of a TypeORM QueryRunner the lease needs; a spec supplies it without a cast. */
export interface LeaseConnection {
  connect(): Promise<void>;
  startTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** The slice of a TypeORM DataSource the lease needs. */
export interface LeaseConnectionFactory {
  createQueryRunner(): LeaseConnection;
}

/** The slice of CronHeartbeatService the runner needs. */
export interface ScheduledJobHeartbeat {
  declare(job: string): void;
  recordSkipped(job: string): void;
  track<T>(job: string, body: () => Promise<T>): Promise<T>;
}

const TRY_LOCK_SQL = 'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS locked';

@Injectable()
export class ScheduledJobRunner implements ScheduledJobExecutor, OnModuleInit {
  private readonly logger = new Logger(ScheduledJobRunner.name);

  constructor(
    @Inject(SCHEDULED_JOB_OPTIONS)
    private readonly options: ScheduledJobModuleOptions,
    @InjectDataSource()
    private readonly dataSource: LeaseConnectionFactory,
    @Inject(CronHeartbeatService)
    private readonly heartbeat: ScheduledJobHeartbeat,
  ) {}

  /** Seed every job this process declared so "never ran" is a value, not a missing series. */
  onModuleInit(): void {
    const names = registeredScheduledJobNames();
    for (const name of names) this.heartbeat.declare(name);
    this.logger.log(
      `Scheduled jobs registered for ${this.options.serviceName}: ${names.length} (${names.join(', ')})`,
    );
  }

  async run(
    job: string,
    body: () => Promise<void>,
    scope: ScheduledJobScope = 'cluster-single',
  ): Promise<ScheduledJobOutcome> {
    if (scope === 'each-replica') {
      await this.heartbeat.track(job, body);
      return 'ran';
    }
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = queryRowsNormalized<{ locked: boolean }>(
        await runner.query(TRY_LOCK_SQL, [this.options.serviceName, job]),
      );
      if (rows[0]?.locked !== true) {
        this.heartbeat.recordSkipped(job);
        return 'skipped';
      }
      await this.heartbeat.track(job, body);
      return 'ran';
    } finally {
      // The lock is transaction-scoped: rolling back releases it. Nothing
      // was written on this connection, so rollback and commit are equivalent
      // and rollback is the one that cannot leave a half-committed state.
      await runner.rollbackTransaction();
      await runner.release();
    }
  }
}
