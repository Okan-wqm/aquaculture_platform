/**
 * Immutable migration snapshot. Runtime evolution must mint a new migration;
 * 181000 consumes only this value copy and its pinned semantic digest.
 */
export const FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_V1 = Object.freeze({
  schemaVersion: 'feeding-record-write-provenance/v1',
  relation: 'feeding_record_write_provenance',
  quarantineProjection: 'feeding_record_write_provenance_quarantine_v1',
  appendFunction: 'append_feeding_record_write_provenance_v1',
  backfillRegistrationFunction: 'register_feeding_record_backfill_write_v1',
  internalAppendFunction: 'append_feeding_record_write_provenance_authority_v1',
  recordDigestFunction: 'feeding_record_write_digest_v1',
  origins: Object.freeze([
    'BACKFILL_180660',
    'LIVE_DRAIN',
    'RUNTIME_OPERATION',
    'AMBIGUOUS_PRE_AUTHORITY',
  ]),
  writerAuthorities: Object.freeze({
    backfill180660: 'db-migrate/1806600000000',
    legacyQuarantine: 'db-migrate/1810000000000-quarantine',
    runtime: 'farm-service/feeding-aggregate-mutation-port/v1',
  }),
  immutableCoordinates: Object.freeze(['writerAuthority', 'operationId', 'origin']),
  ambiguousOrigin: 'AMBIGUOUS_PRE_AUTHORITY',
  rollback: Object.freeze({
    relation: 'feeding_record_backfill_rollback_journal',
    function: 'rollback_feeding_record_backfill_v1',
    phases: Object.freeze(['PREPARED', 'APPLIED']),
    eligibleOrigin: 'BACKFILL_180660',
    compareAndSwap: 'exact-target-set-digest',
    retryIdentity: 'rollback-operation-id',
  }),
});

export const FEEDING_RECORD_WRITE_PROVENANCE_MIGRATION_SNAPSHOT_DIGEST_V1 =
  'f27e6565e9d797a8f822b6aec937ebec2b96a286f48ca9df1a8db9e6f95c9b5f';
