import { canonicalJsonSha256, createCanonicalJsonDocumentV1 } from '@aquaculture/shared-contracts';

import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_CANONICAL_JSON,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_CAPABILITIES,
  FEEDING_DAILY_SUMMARY_SETTLEMENT_V1,
  FEEDING_SCHEDULE_KINDS,
  FEEDING_SCHEDULED_JOB_IDS,
  FEEDING_SITE_SCHEDULED_JOB_IDS,
  FEEDING_TENANT_SCHEDULED_JOB_IDS,
  type LocalDailyFeedingJob,
  compileFeedingJobCatalog,
  canonicalizeFeedingCatalogArtifact,
  feedingDailySummaryPlanDate,
  feedingDueOccurrences,
  feedingJobDefinition,
  isSiteScheduledFeedingJobId,
  isTenantScheduledFeedingJobId,
} from './feeding-job-catalog';
import { FEEDING_UTC_TIMEZONE, compileFeedingTimezone } from './feeding-timezone';

function localDaily(
  localTime: `${number}${number}:${number}${number}`,
  catchUpWindowMinutes = 180,
): LocalDailyFeedingJob {
  return {
    id: 'v2.day-plan.generate',
    capability: 'scheduled.v2',
    scheduleKind: 'local_daily',
    clockProfile: 'site_local',
    targetCardinality: 'site',
    localTime,
    timezoneSource: 'tenant_site_catalog',
    misfire: {
      mode: 'catch_up',
      catchUpWindowMinutes,
      dstGap: 'next_valid_instant',
      dstFold: 'single_semantic_occurrence',
    },
    leaseSeconds: 60,
    enabled: true,
  };
}

describe('feeding job catalog authority', () => {
  it('has one deterministic digest and no duplicate job identity', () => {
    expect(new Set(FEEDING_JOB_CATALOG.map((job) => job.id)).size).toBe(FEEDING_JOB_CATALOG.length);
    expect(
      canonicalJsonSha256(
        {
          domain: 'aquaculture.feeding-job-catalog',
          schemaVersion: FEEDING_JOB_CATALOG_REVISION,
        },
        createCanonicalJsonDocumentV1(JSON.parse(FEEDING_JOB_CATALOG_CANONICAL_JSON) as unknown),
      ),
    ).toBe(FEEDING_JOB_CATALOG_DIGEST);
    expect(FEEDING_JOB_CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires typed misfire policy for every scheduled identity and none for requests', () => {
    for (const job of FEEDING_JOB_CATALOG) {
      if (job.scheduleKind === 'on_demand') {
        expect(job.misfire).toBeNull();
      } else {
        const misfire = job.misfire;
        if (!misfire) {
          throw new Error(`Scheduled feeding job ${job.id} has no misfire policy`);
        }
        expect(misfire).toMatchObject({
          mode: 'catch_up',
          dstGap: 'next_valid_instant',
          dstFold: 'single_semantic_occurrence',
        });
        expect(misfire.catchUpWindowMinutes).toBeGreaterThan(0);
      }
    }
  });

  it('settles only the previous local day after the maximum shifted meal plus overdue grace', () => {
    const definition = feedingJobDefinition('v2.daily-summary.publish');
    expect(definition).toMatchObject({
      localTime: FEEDING_DAILY_SUMMARY_SETTLEMENT_V1.occurrenceLocalTime,
    });
    expect(FEEDING_DAILY_SUMMARY_SETTLEMENT_V1).toEqual({
      schemaVersion: 'feeding-daily-summary-settlement/v1',
      occurrenceLocalTime: '18:00',
      subjectDayOffset: -1,
    });
    expect(feedingDailySummaryPlanDate('2026-03-01')).toBe('2026-02-28');
    expect(feedingDailySummaryPlanDate('2028-03-01')).toBe('2028-02-29');
    const occurrence = feedingDueOccurrences(
      definition,
      new Date('2026-07-21T18:00:00.000Z'),
      FEEDING_UTC_TIMEZONE,
    );
    expect(occurrence).toHaveLength(1);
    expect(feedingDailySummaryPlanDate(occurrence[0]!.localDate)).toBe('2026-07-20');
  });

  it('partitions every scheduled identity into exactly one catalog-derived target cardinality', () => {
    expect([...FEEDING_SITE_SCHEDULED_JOB_IDS, ...FEEDING_TENANT_SCHEDULED_JOB_IDS].sort()).toEqual(
      [...FEEDING_SCHEDULED_JOB_IDS].sort(),
    );
    const tenantJobs = new Set<string>(FEEDING_TENANT_SCHEDULED_JOB_IDS);
    expect(FEEDING_SITE_SCHEDULED_JOB_IDS.filter((jobId) => tenantJobs.has(jobId))).toEqual([]);
    for (const jobId of FEEDING_SCHEDULED_JOB_IDS) {
      expect(
        Number(isSiteScheduledFeedingJobId(jobId)) + Number(isTenantScheduledFeedingJobId(jobId)),
      ).toBe(1);
    }
  });

  it('recursively freezes every exported authority object before digest consumers can read it', () => {
    expect(Object.isFrozen(FEEDING_JOB_CATALOG)).toBe(true);
    expect(Object.isFrozen(FEEDING_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(FEEDING_SCHEDULE_KINDS)).toBe(true);
    for (const job of FEEDING_JOB_CATALOG) {
      expect(Object.isFrozen(job)).toBe(true);
      if (job.misfire) expect(Object.isFrozen(job.misfire)).toBe(true);
    }

    const definition = feedingJobDefinition('v2.day-plan.generate');
    const definitionMisfire = definition.misfire;
    if (!definitionMisfire) {
      throw new Error('Governed day-plan job has no misfire policy');
    }
    const digestBefore = FEEDING_JOB_CATALOG_DIGEST;
    expect(Reflect.set(definition, 'localTime', '22:22')).toBe(false);
    expect(Reflect.set(definitionMisfire, 'catchUpWindowMinutes', 1)).toBe(false);
    expect(feedingJobDefinition('v2.day-plan.generate')).toMatchObject({ localTime: '06:00' });
    expect(FEEDING_JOB_CATALOG_DIGEST).toBe(digestBefore);
  });

  it('rejects open, malformed, duplicated and authority-inconsistent catalog definitions', () => {
    const source = FEEDING_JOB_CATALOG.map((job) => ({
      ...job,
      misfire: job.misfire ? { ...job.misfire } : null,
    }));
    const first = source[0];
    if (!first) {
      throw new Error('Governed feeding catalog unexpectedly has no first definition');
    }

    expect(() =>
      compileFeedingJobCatalog([{ ...first, unexpected: true }, ...source.slice(1)]),
    ).toThrow(/exactly/);
    expect(() =>
      compileFeedingJobCatalog([{ ...first, localTime: '25:99' }, ...source.slice(1)]),
    ).toThrow(/localTime/);
    expect(() =>
      compileFeedingJobCatalog([{ ...first, leaseSeconds: 0 }, ...source.slice(1)]),
    ).toThrow(/leaseSeconds/);
    expect(() =>
      compileFeedingJobCatalog([{ ...first, targetCardinality: 'tenant' }, ...source.slice(1)]),
    ).toThrow(/clock and target/);
    expect(() => compileFeedingJobCatalog([first, first, ...source.slice(2)])).toThrow(/duplicate/);
  });

  it('rejects values that cannot have one unambiguous canonical JSON byte representation', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    class CatalogLike {
      readonly revision = 'not-a-plain-object';
    }
    interface CyclicValue {
      self?: CyclicValue;
    }
    const cyclic: CyclicValue = {};
    cyclic.self = cyclic;

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, sparse, new CatalogLike(), cyclic]) {
      expect(() => canonicalizeFeedingCatalogArtifact(value)).toThrow();
    }
  });

  it('reconciles a daily occurrence after a restart inside its catch-up window', () => {
    const due = feedingDueOccurrences(
      localDaily('06:00'),
      new Date('2026-02-10T07:15:00.000Z'),
      FEEDING_UTC_TIMEZONE,
    );
    expect(due).toEqual([
      expect.objectContaining({
        scheduleKey: '2026-02-10',
        dueAt: new Date('2026-02-10T06:00:00.000Z'),
        caughtUp: true,
        dstGapAdjusted: false,
      }),
    ]);
  });

  it('does not invent a daily occurrence outside the catalogued catch-up window', () => {
    expect(
      feedingDueOccurrences(
        localDaily('06:00', 60),
        new Date('2026-02-10T07:01:00.000Z'),
        FEEDING_UTC_TIMEZONE,
      ),
    ).toEqual([]);
  });

  it('maps a spring-forward gap to the first valid instant after the gap', () => {
    const due = feedingDueOccurrences(
      localDaily('02:30'),
      new Date('2026-03-29T01:05:00.000Z'),
      compileFeedingTimezone('Europe/Oslo'),
    );
    expect(due[0]).toMatchObject({
      scheduleKey: '2026-03-29',
      dueAt: new Date('2026-03-29T01:00:00.000Z'),
      dstGapAdjusted: true,
    });
  });

  it('collapses both fall-back wall-clock copies into one semantic key', () => {
    const due = feedingDueOccurrences(
      localDaily('02:30'),
      new Date('2026-10-25T01:45:00.000Z'),
      compileFeedingTimezone('Europe/Oslo'),
    );
    expect(due[0]).toMatchObject({
      scheduleKey: '2026-10-25',
      dueAt: new Date('2026-10-25T00:30:00.000Z'),
    });
  });

  it('enumerates interval ledger keys oldest-first for catch-up reconciliation', () => {
    const definition = FEEDING_JOB_CATALOG.find((job) => job.id === 'v2.meal-window.sweep');
    if (!definition) {
      throw new Error('Governed meal-window job is absent from the feeding catalog');
    }
    const due = feedingDueOccurrences(
      definition,
      new Date('2026-02-10T10:37:00.000Z'),
      FEEDING_UTC_TIMEZONE,
    );
    expect(due.map((occurrence) => occurrence.scheduleKey)).toEqual([
      '2026-02-10T10:15:00.000Z',
      '2026-02-10T10:30:00.000Z',
    ]);
  });
});
