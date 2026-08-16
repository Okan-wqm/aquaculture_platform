import {
  FEEDING_RECORD_WRITE_ORIGINS,
  FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY,
  FEEDING_RECORD_WRITE_PROVENANCE_CATALOG_DIGEST,
  compileFeedingRecordRollbackExactSetProofV1,
} from '../feeding-record-write-provenance';

describe('feeding-record write provenance authority', () => {
  const first = {
    feedingRecordId: '11111111-1111-4111-8111-111111111111',
    recordDigest: 'a'.repeat(64),
  };
  const second = {
    feedingRecordId: '22222222-2222-4222-8222-222222222222',
    recordDigest: 'b'.repeat(64),
  };

  it('owns the closed origin vocabulary and typed rollback path', () => {
    expect(FEEDING_RECORD_WRITE_ORIGINS).toEqual([
      'BACKFILL_180660',
      'LIVE_DRAIN',
      'RUNTIME_OPERATION',
      'AMBIGUOUS_PRE_AUTHORITY',
    ]);
    expect(FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY.immutableCoordinates).toEqual([
      'writerAuthority',
      'operationId',
      'origin',
    ]);
    expect(FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY.rollback).toMatchObject({
      phases: ['PREPARED', 'APPLIED'],
      eligibleOrigin: 'BACKFILL_180660',
      compareAndSwap: 'exact-target-set-digest',
    });
    expect(FEEDING_RECORD_WRITE_PROVENANCE_CATALOG_DIGEST).toBe(
      'f27e6565e9d797a8f822b6aec937ebec2b96a286f48ca9df1a8db9e6f95c9b5f',
    );
  });

  it('compiles an order-independent exact set proof', () => {
    expect(compileFeedingRecordRollbackExactSetProofV1([second, first])).toEqual(
      compileFeedingRecordRollbackExactSetProofV1([first, second]),
    );
  });

  it('rejects empty, duplicate, and malformed destructive target sets', () => {
    expect(() => compileFeedingRecordRollbackExactSetProofV1([])).toThrow('cannot be empty');
    expect(() => compileFeedingRecordRollbackExactSetProofV1([first, first])).toThrow(
      'Duplicate',
    );
    expect(() =>
      compileFeedingRecordRollbackExactSetProofV1([{ ...first, recordDigest: 'bad' }]),
    ).toThrow('Invalid');
  });
});
