import { createHash } from 'node:crypto';

/**
 * Immutable value snapshot consumed by the 180860..180960 feeding migrations.
 *
 * Runtime authorities intentionally do not flow into a timestamped migration:
 * changing a live contract must produce a new migration and a new versioned
 * snapshot. Every migration that consumes this artifact pins its semantic
 * digest in its own source, so changing this file cannot silently rewrite the
 * historical SQL assembled by an already-shipped migration.
 */
export const FEEDING_MIGRATION_AUTHORITY_V1 = Object.freeze({
  schemaVersion: 'feeding-migration-authority/v1',
  migrationExecution: Object.freeze({
    propertyName: 'migrationExecutionScope',
    declarations: Object.freeze({
      createControlPlane: Object.freeze({
        schemaVersion: 'migration-execution-scope/v1',
        scope: 'source-only',
        reason:
          'feeding catalog artifacts, admission fence, operation leases, and transition evidence are source-only control-plane state',
      }),
      installMutationKernel: Object.freeze({
        schemaVersion: 'migration-execution-scope/v1',
        scope: 'source-only',
        reason:
          'feeding operation mutation functions and ACL protect the source-only control plane',
      }),
    }),
  }),
  roles: Object.freeze({
    databaseOwner: 'farm_schema_owner',
    runtime: 'farm_service',
    scheduler: 'farm_feeding_scheduler',
    migration: 'db_migrate',
  }),
  resultArtifact: Object.freeze({
    hashDomain: 'aquaculture.feeding-operation-result-payload',
    hashSchemaVersion: 'feeding-operation-result-payload/v1',
    portability: Object.freeze({
      forbiddenStringCodePoint: 0,
      maxPayloadBytes: 65_536,
      maxDepth: 64,
      maxSafeInteger: Number.MAX_SAFE_INTEGER,
      minNonZeroNumber: 0.000_001,
      objectKeyPattern: '^[A-Za-z][A-Za-z0-9_]{0,79}$',
    }),
  }),
  controlPlane: Object.freeze({
    relations: Object.freeze([
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_catalog_revisions' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_job_catalog_entries' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_catalog_admission' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_catalog_admission_history' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_writer_authority' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_writer_authority_history' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_schedule_dispatches' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_schedule_dispatch_transitions' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_job_runs' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_job_run_transitions' }),
      Object.freeze({ kind: 'TABLE', name: 'farm.feeding_scheduler_heartbeat' }),
      Object.freeze({ kind: 'VIEW', name: 'farm.feeding_job_run_projection' }),
    ]),
    sequences: Object.freeze([
      'farm.feeding_schedule_dispatch_transitions_id_seq',
      'farm.feeding_job_run_transitions_id_seq',
    ]),
    helperFunctions: Object.freeze([
      'farm.jsonb_has_exact_keys(jsonb,text[])',
      'farm.is_valid_feeding_catalog_job(jsonb)',
      'farm.canonical_feeding_json(jsonb)',
      'farm.is_valid_feeding_result_payload(jsonb)',
      'farm.feeding_result_hash_preimage(varchar,text)',
      'farm.feeding_result_digest(varchar,text)',
      'farm.reject_feeding_append_only_mutation()',
      'farm.validate_feeding_catalog_entry_insert()',
    ]),
    kernelFunctions: Object.freeze([
      'farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb)',
      'farm.transition_feeding_writer_authority(uuid,bigint,varchar,varchar,varchar,varchar,varchar,jsonb)',
      'farm.claim_feeding_job(uuid,varchar,varchar,date,varchar,varchar,varchar,varchar,uuid,varchar,varchar,varchar,bigint,bigint,varchar,jsonb)',
      'farm.complete_feeding_job(uuid,uuid,varchar,varchar,varchar,text,varchar,jsonb)',
      'farm.fail_feeding_job(uuid,uuid,varchar,varchar,jsonb)',
      'farm.compile_feeding_job_targets(varchar,varchar,varchar,timestamptz)',
      'farm.compile_feeding_scheduler_cut(varchar,varchar,timestamptz)',
      'farm.feeding_schedule_occurrence_matches(jsonb,timestamptz,varchar,varchar,timestamptz,date,boolean,boolean)',
      'farm.is_current_feeding_schedule_dispatch(uuid)',
      'farm.feeding_schedule_dispatch_claimability(uuid,timestamptz)',
      'farm.enqueue_feeding_schedule_dispatch(jsonb)',
      'farm.claim_feeding_schedule_dispatch(varchar)',
      'farm.complete_feeding_schedule_dispatch(uuid,uuid,uuid)',
      'farm.release_feeding_schedule_dispatch(uuid,uuid,varchar,varchar)',
      'farm.record_feeding_scheduler_sweep(jsonb)',
      'farm.read_feeding_scheduler_health(timestamptz)',
    ]),
    tenantRuntimeFunctions: Object.freeze([
      'farm.claim_feeding_job(uuid,varchar,varchar,date,varchar,varchar,varchar,varchar,uuid,varchar,varchar,varchar,bigint,bigint,varchar,jsonb)',
      'farm.complete_feeding_job(uuid,uuid,varchar,varchar,varchar,text,varchar,jsonb)',
      'farm.fail_feeding_job(uuid,uuid,varchar,varchar,jsonb)',
      'farm.claim_feeding_schedule_dispatch(varchar)',
      'farm.complete_feeding_schedule_dispatch(uuid,uuid,uuid)',
      'farm.release_feeding_schedule_dispatch(uuid,uuid,varchar,varchar)',
    ]),
    schedulerFunctions: Object.freeze([
      'farm.compile_feeding_job_targets(varchar,varchar,varchar,timestamptz)',
      'farm.compile_feeding_scheduler_cut(varchar,varchar,timestamptz)',
      'farm.enqueue_feeding_schedule_dispatch(jsonb)',
      'farm.record_feeding_scheduler_sweep(jsonb)',
      'farm.read_feeding_scheduler_health(timestamptz)',
    ]),
    migrationFunctions: Object.freeze([
      'farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb)',
      'farm.transition_feeding_writer_authority(uuid,bigint,varchar,varchar,varchar,varchar,varchar,jsonb)',
    ]),
    migrationRelationPrivileges: Object.freeze([
      Object.freeze({ name: 'farm.feeding_catalog_revisions', privileges: 'SELECT, INSERT' }),
      Object.freeze({ name: 'farm.feeding_job_catalog_entries', privileges: 'SELECT, INSERT' }),
      Object.freeze({ name: 'farm.feeding_catalog_admission', privileges: 'SELECT' }),
      Object.freeze({ name: 'farm.feeding_catalog_admission_history', privileges: 'SELECT' }),
      Object.freeze({ name: 'farm.feeding_writer_authority', privileges: 'SELECT' }),
      Object.freeze({ name: 'farm.feeding_writer_authority_history', privileges: 'SELECT' }),
    ]),
  }),
  schedulerObservability: Object.freeze({
    schemaVersion: 'feeding-schedule-sweep-evidence/v1',
    authority: 'feeding-scheduler',
    maxHeartbeatAgeSeconds: 180,
    dispositionKeys: Object.freeze([
      'enqueued',
      'idempotent',
      'business_slot_preserved',
      'already_completed',
      'already_running',
      'quarantined',
    ]),
  }),
  protocolResolution: Object.freeze({
    schemaVersion: 'protocol-resolution/v1',
    exactKeys: Object.freeze([
      'bandBasisWeightG',
      'bandIndex',
      'baseRatePercent',
      'effectiveRatePercent',
      'expectedFcr',
      'fcrResolvedSource',
      'feed',
      'resolvedAt',
      'schemaVersion',
      'temperatureSource',
      'tempMultiplier',
      'waterTempC',
    ]),
    feedExactKeys: Object.freeze(['code', 'id', 'name']),
    fcrResolvedSources: Object.freeze(['override', 'band', 'matrix', 'feed']),
    temperatureSources: Object.freeze(['sensor', 'manual', 'none']),
  }),
  dayPlanRecalculationAudit: Object.freeze({
    revision: 'day-plan-recalc-audit/v1',
    retainedEntries: 50,
  }),
  feedingMethods: Object.freeze(['manual', 'automatic', 'demand', 'broadcast', 'spot']),
  forecastProjection: Object.freeze({
    schemaVersion: 'feeding-forecast-projection/v1',
    tenantScopeKey: 'tenant',
    generation: Object.freeze({
      schemaVersion: 'feeding-forecast-generation/v1',
      catalogDigest: '0c0143e09b0634400c6e6b79305a4b75ae62f19bafe2c3578dc2ee90056338a1',
      states: Object.freeze(['BUILDING', 'QUALIFIED', 'ACTIVE', 'RETIRED']),
      generationRelation: 'feeding_forecast_generations',
      snapshotRelation: 'feeding_forecast_snapshots',
      activePointerRelation: 'feeding_forecast_active_generation',
      activeProjection: 'feeding_forecast_active_snapshots_v1',
      legacyQuarantineRelation: 'feeding_forecast_legacy_quarantine',
      mutationFunctions: Object.freeze({
        qualify: 'qualify_feeding_forecast_generation_v1',
        activate: 'activate_feeding_forecast_generation_v1',
        purgeRetired: 'purge_feeding_forecast_generations_v1',
      }),
    }),
  }),
});

type FeedingMigrationExecutionDeclarationV1 =
  (typeof FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations)[keyof typeof FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations];

function feedingMigrationExecutionDeclarationV1(
  target: object,
): FeedingMigrationExecutionDeclarationV1 | undefined {
  const value = Object.getOwnPropertyDescriptor(
    target,
    FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.propertyName,
  )?.value;
  return Object.values(FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations).find(
    (declaration) => declaration === value,
  );
}

/**
 * Projects the exact feeding control-plane migration prefix from the canonical
 * farm migration order. Missing, duplicated, forged, or reordered authority
 * declarations fail before any migration can execute.
 */
export function projectFeedingMigrationExecutionTargetsV1<Target extends object>(
  canonicalTargets: readonly Target[],
): readonly Target[] {
  const expected = Object.values(FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations);
  const projected: Target[] = [];
  const observed: FeedingMigrationExecutionDeclarationV1[] = [];
  for (const target of canonicalTargets) {
    const declaration = feedingMigrationExecutionDeclarationV1(target);
    if (!declaration) continue;
    projected.push(target);
    observed.push(declaration);
  }
  if (
    observed.length !== expected.length ||
    observed.some((declaration, index) => declaration !== expected[index])
  ) {
    throw new Error(
      'Feeding migration execution projection differs from its exact canonical authority order',
    );
  }
  return Object.freeze(projected);
}

export function bindFeedingMigrationExecutionScopeV1(
  target: object,
  declaration: FeedingMigrationExecutionDeclarationV1,
): void {
  const isAuthorityDeclaration = Object.values(
    FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations,
  ).some((candidate) => candidate === declaration);
  if (!isAuthorityDeclaration) {
    throw new TypeError('Feeding migration execution scope must use its v1 authority declaration');
  }
  Object.defineProperty(target, FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.propertyName, {
    configurable: false,
    enumerable: false,
    value: declaration,
    writable: false,
  });
}

const FEEDING_MIGRATION_AUTHORITY_V1_SERIALIZED = JSON.stringify(FEEDING_MIGRATION_AUTHORITY_V1);

export const FEEDING_MIGRATION_AUTHORITY_V1_DIGEST = createHash('sha256')
  .update(FEEDING_MIGRATION_AUTHORITY_V1_SERIALIZED, 'utf8')
  .digest('hex');

export function assertFeedingMigrationAuthorityV1(expectedDigest: string): void {
  if (expectedDigest !== FEEDING_MIGRATION_AUTHORITY_V1_DIGEST) {
    throw new Error(
      `Feeding migration authority v1 digest mismatch: expected ${expectedDigest}, ` +
        `observed ${FEEDING_MIGRATION_AUTHORITY_V1_DIGEST}`,
    );
  }
}
