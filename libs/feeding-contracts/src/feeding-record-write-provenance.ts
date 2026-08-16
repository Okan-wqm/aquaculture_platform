import { canonicalWireJsonSha256V1, sha256Hex } from '@aquaculture/shared-contracts';

import { freezeAuthorityGraphV1 } from './authority-immutability';

export const FEEDING_RECORD_WRITE_PROVENANCE_REVISION =
  'feeding-record-write-provenance/v1';

export const FEEDING_RECORD_WRITE_ORIGINS = Object.freeze([
  'BACKFILL_180660',
  'LIVE_DRAIN',
  'RUNTIME_OPERATION',
  'AMBIGUOUS_PRE_AUTHORITY',
] as const);

export type FeedingRecordWriteOrigin = (typeof FEEDING_RECORD_WRITE_ORIGINS)[number];

export const FEEDING_RECORD_WRITER_AUTHORITIES = Object.freeze({
  backfill180660: 'db-migrate/1806600000000',
  legacyQuarantine: 'db-migrate/1810000000000-quarantine',
  runtime: 'farm-service/feeding-aggregate-mutation-port/v1',
} as const);

const FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY_SOURCE = {
  schemaVersion: FEEDING_RECORD_WRITE_PROVENANCE_REVISION,
  relation: 'feeding_record_write_provenance',
  quarantineProjection: 'feeding_record_write_provenance_quarantine_v1',
  appendFunction: 'append_feeding_record_write_provenance_v1',
  backfillRegistrationFunction: 'register_feeding_record_backfill_write_v1',
  internalAppendFunction: 'append_feeding_record_write_provenance_authority_v1',
  recordDigestFunction: 'feeding_record_write_digest_v1',
  origins: FEEDING_RECORD_WRITE_ORIGINS,
  writerAuthorities: FEEDING_RECORD_WRITER_AUTHORITIES,
  immutableCoordinates: ['writerAuthority', 'operationId', 'origin'] as const,
  ambiguousOrigin: 'AMBIGUOUS_PRE_AUTHORITY',
  rollback: {
    relation: 'feeding_record_backfill_rollback_journal',
    function: 'rollback_feeding_record_backfill_v1',
    phases: ['PREPARED', 'APPLIED'] as const,
    eligibleOrigin: 'BACKFILL_180660',
    compareAndSwap: 'exact-target-set-digest',
    retryIdentity: 'rollback-operation-id',
  },
} as const;

export const FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY = freezeAuthorityGraphV1(
  FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY_SOURCE,
);

export const FEEDING_RECORD_WRITE_PROVENANCE_CATALOG_DIGEST =
  canonicalWireJsonSha256V1(
    {
      domain: 'aquaculture.feeding-record-write-provenance-catalog',
      schemaVersion: FEEDING_RECORD_WRITE_PROVENANCE_REVISION,
    },
    FEEDING_RECORD_WRITE_PROVENANCE_AUTHORITY,
  );

export interface FeedingRecordRollbackTargetV1 {
  readonly feedingRecordId: string;
  readonly recordDigest: string;
}

export interface FeedingRecordRollbackExactSetProofV1 {
  readonly targetSetDigest: string;
  readonly recordCount: number;
  readonly targets: readonly FeedingRecordRollbackTargetV1[];
}

const UUID_V4_COMPATIBLE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Compiles the same length-delimited, byte-ordered membership preimage used by
 * the PostgreSQL rollback authority. This is an exact set: duplicates and
 * malformed coordinates fail before a destructive request can be admitted.
 */
export function compileFeedingRecordRollbackExactSetProofV1(
  targets: readonly FeedingRecordRollbackTargetV1[],
): FeedingRecordRollbackExactSetProofV1 {
  if (targets.length === 0) {
    throw new Error('Feeding-record rollback target set cannot be empty');
  }
  const seen = new Set<string>();
  const normalized = targets
    .map((target) => {
      const feedingRecordId = target.feedingRecordId.toLowerCase();
      if (!UUID_V4_COMPATIBLE.test(feedingRecordId)) {
        throw new Error(`Invalid feeding-record rollback identity ${target.feedingRecordId}`);
      }
      if (!SHA256_HEX.test(target.recordDigest)) {
        throw new Error(`Invalid feeding-record rollback digest for ${feedingRecordId}`);
      }
      if (seen.has(feedingRecordId)) {
        throw new Error(`Duplicate feeding-record rollback identity ${feedingRecordId}`);
      }
      seen.add(feedingRecordId);
      return Object.freeze({ feedingRecordId, recordDigest: target.recordDigest });
    })
    .sort((left, right) =>
      left.feedingRecordId < right.feedingRecordId
        ? -1
        : left.feedingRecordId > right.feedingRecordId
          ? 1
          : 0,
    );
  const frozen = Object.freeze(normalized);
  const preimage = frozen
    .map(
      ({ feedingRecordId, recordDigest }) =>
        `${feedingRecordId.length}:${feedingRecordId}|${recordDigest}`,
    )
    .join('\n');
  return Object.freeze({
    targetSetDigest: sha256Hex(preimage),
    recordCount: frozen.length,
    targets: frozen,
  });
}
