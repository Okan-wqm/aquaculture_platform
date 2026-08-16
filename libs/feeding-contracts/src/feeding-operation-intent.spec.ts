import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  feedingDueOccurrences,
  feedingJobDefinition,
} from './feeding-job-catalog';
import { compileFeedingOperationLockSetDigestV1 } from './feeding-operation-envelope';
import { feedingOperationCommandDigestV1 } from './feeding-operation-command-digest';
import { decodeFeedingOperationIntentV1 } from './feeding-operation-intent';
import { compileFeedingTimezone } from './feeding-timezone';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

function validIntent(): Record<string, unknown> {
  const commandPayload = {
    jobId: 'v2.forecast.refresh',
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    actorId: 'operator-1',
    requestId: 'forecast-request-1',
    emitCoverageEvents: true,
  } as const;
  return {
    schemaVersion: 'feeding-operation-intent/v1',
    operationId: '33333333-3333-4333-8333-333333333333',
    generation: 7,
    tenantId: TENANT_ID,
    actorId: 'operator-1',
    requestId: 'forecast-request-1',
    jobId: 'v2.forecast.refresh',
    targetKind: 'site',
    targetId: SITE_ID,
    siteId: SITE_ID,
    unitId: null,
    reason: 'operator_request',
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    commandDigest: feedingOperationCommandDigestV1(commandPayload),
    commandPayload,
    lockSetDigest: compileFeedingOperationLockSetDigestV1({
      tenantId: TENANT_ID,
      jobId: 'v2.forecast.refresh',
      targetKind: 'site',
      targetId: SITE_ID,
      localDate: '2026-08-05',
    }),
    observedAt: '2026-08-05T04:00:30.000Z',
    dueAt: '2026-08-05T04:00:00.000Z',
    scheduleKey: 'forecast-request-1',
    localDate: '2026-08-05',
    timezone: 'Europe/Oslo',
    caughtUp: false,
    dstGapAdjusted: false,
    timezoneSource: 'tenant_site_catalog',
    catalogAdmissionGeneration: null,
    authorityGeneration: null,
    targetSetDigest: null,
    schedulerCutDigest: null,
    dispatchDigest: null,
  };
}

function validScheduledIntent(): Record<string, unknown> {
  const observedAt = new Date('2026-08-05T04:30:30.000Z');
  const timezone = compileFeedingTimezone('Europe/Oslo');
  const occurrence = feedingDueOccurrences(
    feedingJobDefinition('v2.day-plan.generate'),
    observedAt,
    timezone,
  )[0];
  if (!occurrence) throw new Error('scheduled intent fixture has no canonical occurrence');
  const commandPayload = {
    jobId: 'v2.day-plan.generate',
    tenantId: TENANT_ID,
    siteId: SITE_ID,
  } as const;
  return {
    ...validIntent(),
    actorId: null,
    requestId: null,
    jobId: 'v2.day-plan.generate',
    reason: 'scheduled_reconciliation',
    commandDigest: feedingOperationCommandDigestV1(commandPayload),
    commandPayload,
    lockSetDigest: compileFeedingOperationLockSetDigestV1({
      tenantId: TENANT_ID,
      jobId: 'v2.day-plan.generate',
      targetKind: 'site',
      targetId: SITE_ID,
      localDate: occurrence.localDate,
    }),
    observedAt: observedAt.toISOString(),
    dueAt: occurrence.dueAt.toISOString(),
    scheduleKey: occurrence.scheduleKey,
    localDate: occurrence.localDate,
    timezone,
    caughtUp: occurrence.caughtUp,
    dstGapAdjusted: occurrence.dstGapAdjusted,
    catalogAdmissionGeneration: 4,
    authorityGeneration: 7,
    targetSetDigest: 'c'.repeat(64),
    schedulerCutDigest: 'd'.repeat(64),
    dispatchDigest: 'e'.repeat(64),
  };
}

describe('FeedingOperationIntentV1', () => {
  it('strictly decodes the one persisted on-demand operation intent', () => {
    const decoded = decodeFeedingOperationIntentV1(validIntent());

    expect(decoded).toMatchObject({
      operationId: '33333333-3333-4333-8333-333333333333',
      generation: 7,
      scheduleKey: 'forecast-request-1',
      dueAt: '2026-08-05T04:00:00.000Z',
    });
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it.each([
    ['split request identity', { scheduleKey: 'second-idempotency-key' }],
    ['non-minute due time', { dueAt: '2026-08-05T04:00:01.000Z' }],
    ['catch-up flag', { caughtUp: true }],
    ['DST adjustment flag', { dstGapAdjusted: true }],
  ])('rejects %s for an on-demand operation', (_caseName, mutation) => {
    expect(() => decodeFeedingOperationIntentV1({ ...validIntent(), ...mutation })).toThrow(
      /canonical catalog occurrence/i,
    );
  });

  it('rejects a command payload whose canonical digest differs from commandDigest', () => {
    expect(() =>
      decodeFeedingOperationIntentV1({
        ...validIntent(),
        commandPayload: {
          jobId: 'v2.forecast.refresh',
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          actorId: 'operator-1',
          requestId: 'forecast-request-1',
          emitCoverageEvents: false,
        },
      }),
    ).toThrow(/command payload digest/i);
  });

  it.each([
    ['schedule key', { scheduleKey: '2026-08-04' }],
    ['due instant', { dueAt: '2026-08-05T04:01:00.000Z' }],
    ['timezone', { timezone: 'UTC' }],
    ['catch-up flag', { caughtUp: false }],
    ['DST adjustment flag', { dstGapAdjusted: true }],
  ])('rejects a scheduled intent with a non-canonical %s', (_caseName, mutation) => {
    expect(() =>
      decodeFeedingOperationIntentV1({ ...validScheduledIntent(), ...mutation }),
    ).toThrow(/canonical catalog occurrence/i);
  });
});
