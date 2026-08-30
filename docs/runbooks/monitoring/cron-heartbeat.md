# Runbook — scheduled job heartbeat

Covers `CronJobNeverRan` and `CronJobFailingEveryRun`
(`infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`).

## What the heartbeat is

`CronHeartbeatService` (`libs/backend-common/src/metrics/cron-heartbeat.service.ts`)
records that a scheduled job attempted to run and how the attempt ended. It
answers the one question a job's own domain metrics cannot: did it run at all.

The platform has 90 `@Cron` methods. Before this surface existed, five of them
published a last-run gauge and the rest published nothing, so a job that
silently stopped — a scheduler that never registered, a container that came
back without its timers, a constructor that threw — looked identical to a job
with nothing to do.

**Coverage is opt-in and partial on purpose.** A job appears in these series
only after it adopts `heartbeat.track(...)`. An alert that claimed to watch all
90 while watching four would be worse than the gap it replaced.

## CronJobNeverRan (high)

`cron_job_last_success_timestamp_seconds` is still the declared zero an hour
after start: the job announced itself and has never completed.

1. Confirm the service is up and that the scheduler module is registered.
   A missing `ScheduleModule.forRoot()` produces exactly this shape.
2. Check for a constructor or module-init exception in the owning service —
   a provider that throws during bootstrap removes its timers without
   removing the process.
3. If the job legitimately runs less often than hourly, the rule is wrong for
   that job, not the job wrong for the rule: give it its own threshold rather
   than silencing the family.

## CronJobFailingEveryRun (high)

The last failure is newer than the last success, and no success in an hour.

1. `cron_job_runs_total{job="<job>",outcome="failure"}` gives the rate; the
   owning service's logs give the reason.
2. A job that catches and logs its own errors still records a success here,
   because it returned normally. If the domain metrics say healthy and this
   says failing, trust this one — it observes the call, not the intent.
3. Duration is on `cron_job_duration_seconds`; a job failing fast and a job
   timing out need different fixes.

## Adopting the heartbeat for another job

```typescript
constructor(private readonly heartbeat: CronHeartbeatService) {
  this.heartbeat.declare('my-job');
}

@Cron(CronExpression.EVERY_HOUR)
async run(): Promise<void> {
  await this.heartbeat.track('my-job', async () => {
    // existing body, unchanged
  });
}
```

`track` re-throws whatever the body threw, so adopting it cannot change what
the job does — only what is known about it from outside. `declare` in the
constructor is what makes "never ran" visible as a value instead of an absent
series.
