/**
 * CronHeartbeatService — the last-run surface 90 scheduled jobs did not have.
 *
 * WHY THIS EXISTS
 * ---------------
 * The platform runs 90 `@Cron` methods across nine services. Five of them
 * publish a last-run gauge; the rest publish nothing at all. A cron that
 * silently stops — a thrown exception in `onModuleInit`, a scheduler that
 * never registered, a container that came back without its timers — looks
 * exactly like a cron with nothing to do. That is the same failure shape as
 * the tenant-isolation watchdog whose verdict only reached a log line
 * (ORPHAN-HIGH-567), and as `docker ps` reporting "Up" for a container that
 * had exited: absence of bad news read as good news.
 *
 * A heartbeat is not a substitute for the job's own domain metrics. It
 * answers one question the domain metrics cannot: did this job run at all.
 *
 * HOW TO ADOPT
 * ------------
 *   constructor(private readonly heartbeat: CronHeartbeatService) {}
 *
 *   @Cron(CronExpression.EVERY_10_MINUTES)
 *   async sweepStaleLeases(): Promise<void> {
 *     await this.heartbeat.track('sweep-stale-leases', async () => {
 *       ...the existing body, unchanged...
 *     });
 *   }
 *
 * `track` re-throws whatever the body threw, so wrapping a job cannot change
 * its behaviour — it only records that the attempt happened and how it
 * ended. A job that swallows its own errors keeps swallowing them; the
 * failure gauge is what makes that visible from outside.
 *
 * LABEL DISCIPLINE
 * ----------------
 * One label, `job`, carrying the caller-supplied name. No tenant label: the
 * scrape surface is unauthenticated and per-tenant scheduling is not a thing
 * this platform does. Job names are expected to be a small fixed set — they
 * are code constants, not user input — so cardinality is bounded by the
 * source tree.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

import { ServiceMetricsService } from './metrics.service';

/**
 * The one capability the heartbeat needs from the scrape endpoint.
 *
 * Depending on the narrow port rather than the whole ServiceMetricsService
 * is what lets a test supply a two-line stand-in without a cast — and a
 * cast in a test is a claim the type system cannot check, which is exactly
 * where a wrong assumption about the collaborator hides.
 */
export interface MetricsContributorRegistry {
  registerContributor(name: string, registry: client.Registry): void;
}

@Injectable()
export class CronHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronHeartbeatService.name);
  private readonly registry: client.Registry;

  private readonly runs: client.Counter<'cron_job' | 'outcome'>;
  private readonly lastAttempt: client.Gauge<'cron_job'>;
  private readonly lastSuccess: client.Gauge<'cron_job'>;
  private readonly lastFailure: client.Gauge<'cron_job'>;
  private readonly duration: client.Histogram<'cron_job' | 'outcome'>;

  constructor(
    @Inject(ServiceMetricsService)
    private readonly serviceMetrics: MetricsContributorRegistry,
  ) {
    // WHY THE LABEL IS `cron_job` AND NOT `job`:
    //
    // `job` is reserved. Prometheus attaches it to every scraped series to
    // name the scrape target, and with `honor_labels` off — the default, and
    // what this platform runs — a metric that ships its own `job` has it
    // renamed to `exported_job` on ingest. The rule would then read `job` as
    // the scrape target name, `max by (job)` would collapse every scheduled
    // job in a service into ONE series, and the alert text would name the
    // service instead of the job that stopped.
    //
    // This is not hypothetical: the pre-existing `farm_regulatory_cron_*`
    // family shipped a `job` label and is stored under `exported_job` on the
    // production droplet today. The public `track(job, ...)` API keeps the
    // natural word; only the exported label is disambiguated.
    this.registry = new client.Registry();
    this.runs = new client.Counter({
      name: 'cron_job_runs_total',
      help: 'Scheduled job attempts by outcome',
      labelNames: ['cron_job', 'outcome'],
      registers: [this.registry],
    });
    this.lastAttempt = new client.Gauge({
      name: 'cron_job_last_attempt_timestamp_seconds',
      help: 'Unix timestamp of the last attempt of each scheduled job',
      labelNames: ['cron_job'],
      registers: [this.registry],
    });
    this.lastSuccess = new client.Gauge({
      name: 'cron_job_last_success_timestamp_seconds',
      help: 'Unix timestamp of the last successful completion of each scheduled job',
      labelNames: ['cron_job'],
      registers: [this.registry],
    });
    this.lastFailure = new client.Gauge({
      name: 'cron_job_last_failure_timestamp_seconds',
      help: 'Unix timestamp of the last failure of each scheduled job',
      labelNames: ['cron_job'],
      registers: [this.registry],
    });
    this.duration = new client.Histogram({
      name: 'cron_job_duration_seconds',
      help: 'Wall-clock duration of scheduled job runs',
      labelNames: ['cron_job', 'outcome'],
      buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    this.serviceMetrics.registerContributor('cron-heartbeat', this.registry);
    this.logger.log('Cron heartbeat metrics registered');
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  /**
   * Declare a job before it has ever run.
   *
   * Without this, a job that has never executed exports NO series, and
   * `time() - cron_job_last_success_timestamp_seconds > X` matches nothing
   * — so the alert for "this never ran" is silent exactly when it is true.
   * Seeding zero makes the absence visible as a value.
   */
  declare(job: string): void {
    this.lastAttempt.set({ cron_job: job }, 0);
    this.lastSuccess.set({ cron_job: job }, 0);
    this.lastFailure.set({ cron_job: job }, 0);
  }

  /**
   * Record a tick this replica did not run because another replica holds
   * the job's lease (ADMIN-HIGH-013). Not an attempt: the last-attempt gauge
   * stays with the replica that ran, so "never ran anywhere" stays true.
   */
  recordSkipped(job: string): void {
    this.runs.inc({ cron_job: job, outcome: 'skipped' });
  }

  /**
   * Run `body`, recording that the attempt happened and how it ended.
   *
   * Re-throws on failure: wrapping a job must not change what the job does,
   * only what is known about it from outside.
   */
  async track<T>(job: string, body: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this.lastAttempt.set({ cron_job: job }, startedAt / 1000);
    try {
      const result = await body();
      const finishedAt = Date.now();
      this.runs.inc({ cron_job: job, outcome: 'success' });
      this.lastSuccess.set({ cron_job: job }, finishedAt / 1000);
      this.duration.observe({ cron_job: job, outcome: 'success' }, (finishedAt - startedAt) / 1000);
      return result;
    } catch (error) {
      const finishedAt = Date.now();
      this.runs.inc({ cron_job: job, outcome: 'failure' });
      this.lastFailure.set({ cron_job: job }, finishedAt / 1000);
      this.duration.observe({ cron_job: job, outcome: 'failure' }, (finishedAt - startedAt) / 1000);
      throw error;
    }
  }

  /** Prometheus dump of the heartbeat registry (tests + debugging). */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
