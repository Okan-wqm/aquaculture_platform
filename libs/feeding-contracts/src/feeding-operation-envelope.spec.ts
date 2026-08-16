import { FEEDING_JOB_CATALOG_DIGEST } from './feeding-job-catalog';
import {
  compileFeedingOperationEnvelopeV1,
  compileFeedingOperationLockSetDigestV1,
  feedingOperationObservedAtV1,
} from './feeding-operation-envelope';

describe('FeedingOperationEnvelopeV1', () => {
  const observedAt = new Date('2026-08-08T12:30:00.000Z');
  const lockSetDigest = compileFeedingOperationLockSetDigestV1({
    tenantId: '11111111-1111-4111-8111-111111111111',
    jobId: 'mobile.meal.record',
    targetKind: 'unit',
    targetId: '22222222-2222-4222-8222-222222222222',
    localDate: '2026-08-08',
  });

  it('compiles byte-identical immutable coordinates without retaining a mutable Date', () => {
    const input = {
      observedAt,
      catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
      commandDigest: 'a'.repeat(64),
      authorityGeneration: 7,
      lockSetDigest,
    } as const;
    const first = compileFeedingOperationEnvelopeV1(input);
    observedAt.setUTCFullYear(2030);
    const second = compileFeedingOperationEnvelopeV1({
      ...input,
      observedAt: '2026-08-08T12:30:00.000Z',
    });

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.envelope)).toBe(true);
    expect(first.envelope.observedAt).toBe('2026-08-08T12:30:00.000Z');
    expect(feedingOperationObservedAtV1(first.envelope).toISOString()).toBe(
      first.envelope.observedAt,
    );
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects noncanonical time, open digests and invalid generations', () => {
    expect(() =>
      compileFeedingOperationEnvelopeV1({
        observedAt: '2026-08-08T14:30:00.000+02:00',
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        commandDigest: 'a'.repeat(64),
        authorityGeneration: 1,
        lockSetDigest,
      }),
    ).toThrow('canonical UTC');
    expect(() =>
      compileFeedingOperationEnvelopeV1({
        observedAt: '2026-08-08T12:30:00.000Z',
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        commandDigest: 'open',
        authorityGeneration: 0,
        lockSetDigest,
      }),
    ).toThrow();
  });

  it('rejects malformed UUID and impossible local-date lock coordinates', () => {
    const validScope = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      jobId: 'mobile.meal.record' as const,
      targetKind: 'unit' as const,
      targetId: '22222222-2222-4222-8222-222222222222',
      localDate: '2026-08-08',
    };
    expect(() =>
      compileFeedingOperationLockSetDigestV1({ ...validScope, tenantId: 'tenant' }),
    ).toThrow('tenantId');
    expect(() =>
      compileFeedingOperationLockSetDigestV1({ ...validScope, targetId: 'UNIT-A' }),
    ).toThrow('targetId');
    expect(() =>
      compileFeedingOperationLockSetDigestV1({ ...validScope, localDate: '2026-02-30' }),
    ).toThrow('real ISO calendar date');
  });
});
