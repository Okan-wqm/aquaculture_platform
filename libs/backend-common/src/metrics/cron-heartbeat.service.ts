import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

import { ServiceMetricsService } from './metrics.service';

/** Narrow scrape-registry capability used by scheduled-job telemetry. */
export interface MetricsContributorRegistry {
  registerContributor(name: string, registry: client.Registry): void;
}

/**
 * Process-local scheduled-job heartbeat. Jobs are declared before their first
 * run so a never-started timer is observable as zero rather than an absent
 * series. Tracking never changes job behavior: failures are recorded and
 * re-thrown.
 */
@Injectable()
export class CronHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronHeartbeatService.name);
  private readonly registry = new client.Registry();
  private readonly runs: client.Counter<'cron_job' | 'outcome'>;
  private readonly lastAttempt: client.Gauge<'cron_job'>;
  private readonly lastSuccess: client.Gauge<'cron_job'>;
  private readonly lastFailure: client.Gauge<'cron_job'>;
  private readonly duration: client.Histogram<'cron_job' | 'outcome'>;

  constructor(
    @Inject(ServiceMetricsService)
    private readonly serviceMetrics: MetricsContributorRegistry,
  ) {
    // Prometheus owns the `job` target label and renames an exported `job`
    // label to `exported_job`. Keep the public API domain term while giving
    // the wire metric an unambiguous, aggregation-safe label.
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

  declare(job: string): void {
    this.lastAttempt.set({ cron_job: job }, 0);
    this.lastSuccess.set({ cron_job: job }, 0);
    this.lastFailure.set({ cron_job: job }, 0);
  }

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
    } catch (error: unknown) {
      const finishedAt = Date.now();
      this.runs.inc({ cron_job: job, outcome: 'failure' });
      this.lastFailure.set({ cron_job: job }, finishedAt / 1000);
      this.duration.observe({ cron_job: job, outcome: 'failure' }, (finishedAt - startedAt) / 1000);
      throw error;
    }
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
