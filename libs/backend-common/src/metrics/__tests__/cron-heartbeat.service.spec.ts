/**
 * The heartbeat exists to answer one question the domain metrics cannot:
 * did this job run at all. These tests pin the three properties that make
 * that answer trustworthy — a never-run job is visible as a value rather
 * than an absent series, a failure is recorded as a failure instead of
 * silence, and wrapping a job does not change what the job does.
 */
import { CronHeartbeatService, MetricsContributorRegistry } from '../cron-heartbeat.service';

describe('CronHeartbeatService', () => {
  let heartbeat: CronHeartbeatService;
  let registered: string[];

  beforeEach(() => {
    registered = [];
    const serviceMetrics: MetricsContributorRegistry = {
      registerContributor: (name: string): void => {
        registered.push(name);
      },
    };
    heartbeat = new CronHeartbeatService(serviceMetrics);
  });

  afterEach(() => {
    heartbeat.onModuleDestroy();
  });

  it('publishes its registry through the service scrape endpoint', () => {
    heartbeat.onModuleInit();

    expect(registered).toEqual(['cron-heartbeat']);
  });

  it('makes a never-run job visible instead of absent', async () => {
    heartbeat.declare('nightly-reconcile');

    const dump = await heartbeat.getMetrics();

    // A job with no series at all cannot be matched by
    // `time() - cron_job_last_success_timestamp_seconds > X`, so the alert
    // for "this never ran" would be silent exactly when it is true.
    expect(dump).toContain(
      'cron_job_last_success_timestamp_seconds{cron_job="nightly-reconcile"} 0',
    );
  });

  it('records a successful run with its completion time', async () => {
    await heartbeat.track('outbox-relay', () => Promise.resolve(undefined));

    const dump = await heartbeat.getMetrics();

    expect(dump).toContain('cron_job_runs_total{cron_job="outbox-relay",outcome="success"} 1');
    expect(dump).toMatch(
      /cron_job_last_success_timestamp_seconds\{cron_job="outbox-relay"\} 1[6-9]\d{8}/,
    );
  });

  it('records a failed run and re-throws so the job behaves as before', async () => {
    const boom = new Error('connection terminated');

    await expect(heartbeat.track('outbox-relay', async () => Promise.reject(boom))).rejects.toBe(
      boom,
    );

    const dump = await heartbeat.getMetrics();
    expect(dump).toContain('cron_job_runs_total{cron_job="outbox-relay",outcome="failure"} 1');
    expect(dump).toMatch(
      /cron_job_last_failure_timestamp_seconds\{cron_job="outbox-relay"\} 1[6-9]\d{8}/,
    );
  });

  it('returns the body result unchanged', async () => {
    const result = await heartbeat.track('report-builder', () => Promise.resolve({ rows: 42 }));

    expect(result).toEqual({ rows: 42 });
  });

  it('keeps attempts and successes distinguishable for a failing job', async () => {
    await expect(
      heartbeat.track('flaky-job', () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope');

    const dump = await heartbeat.getMetrics();

    // The attempt happened; the success did not. A job that runs and always
    // fails must not look like a job that is not scheduled at all.
    expect(dump).toMatch(
      /cron_job_last_attempt_timestamp_seconds\{cron_job="flaky-job"\} 1[6-9]\d{8}/,
    );
    expect(dump).not.toContain('cron_job_runs_total{cron_job="flaky-job",outcome="success"}');
  });
});
