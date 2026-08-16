import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_CANONICAL_JSON,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_RESULT_PORTABILITY_V1,
  FEEDING_SCHEDULED_JOB_IDS,
  FEEDING_SITE_SCHEDULED_JOB_IDS,
  FEEDING_TENANT_SCHEDULED_JOB_IDS,
  FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY,
  FEEDING_SCHEDULE_EXECUTION_POLICY_V1,
  canonicalizeFeedingCatalogArtifact,
  compileFeedingOperationEnvelopeV1,
  compileFeedingOperationLockSetDigestV1,
  decodeFeedingOperationIntentV1,
  compileFeedingResultArtifactV1,
  compileFeedingTimezone,
  createFeedingScheduledDispatchEnvelope,
  feedingDueOccurrences,
  feedingJobDefinition,
  feedingOperationCommandDigestV1,
  feedingScheduledCommandDigest,
} from '@aquaculture/feeding-contracts';
import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  createCanonicalJsonDocumentV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { type QueryRunner } from 'typeorm';

import {
  FEEDING_CONTROL_PLANE_HELPER_FUNCTIONS,
  FEEDING_CONTROL_PLANE_KERNEL_FUNCTIONS,
  FEEDING_CONTROL_PLANE_RELATIONS,
  FEEDING_CONTROL_PLANE_SEQUENCES,
  FEEDING_DATABASE_OWNER_ROLE,
  FEEDING_MIGRATION_KERNEL_FUNCTIONS,
  FEEDING_MIGRATION_ROLE,
  FEEDING_RUNTIME_ROLE,
  FEEDING_SCHEDULER_KERNEL_FUNCTIONS,
  FEEDING_SCHEDULER_ROLE,
  FEEDING_TENANT_RUNTIME_KERNEL_FUNCTIONS,
} from '../../../farm-service/src/database/feeding-operation-database-authority';
import {
  feedingOperationCommandDigestSqlV1,
  feedingOperationLockSetDigestSqlV1,
} from '../../../farm-service/src/database/migrations/1808700000000-InstallFeedingOperationMutationKernel';
import { projectFeedingMigrationExecutionTargetsV1 } from '../../../farm-service/src/database/migrations/feeding-migration-authority.v1';
import { FARM_MIGRATIONS } from '../../../farm-service/src/database/migrations/manifest';
import type { ForecastRefreshOperationCommand } from '../../../farm-service/src/feeding-protocol/feeding-operation-command';
import { decodeFeedingOperationCommandFromIntentV1 } from '../../../farm-service/src/feeding-protocol/feeding-operation-command.codec';
import {
  activateFeedingWriterAuthority,
  projectFeedingJobCatalog,
  reconcileFeedingWriterAuthorities,
  revokeFeedingWriterAuthority,
} from '../feeding-operation-authority';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const FEEDING_FIXED_CONTROL_PLANE_MIGRATIONS =
  projectFeedingMigrationExecutionTargetsV1(FARM_MIGRATIONS);
const NEXT_DEFINITIONS = FEEDING_JOB_CATALOG.map((definition) =>
  definition.id === 'v2.meal-window.sweep'
    ? { ...definition, intervalMinutes: 20, leaseSeconds: 120 }
    : definition,
);
const NEXT_CANONICAL_JSON = canonicalizeFeedingCatalogArtifact({
  revision: 'feeding-job-catalog/v2',
  dispatchRetryPolicy: FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY,
  scheduleExecutionPolicy: FEEDING_SCHEDULE_EXECUTION_POLICY_V1,
  jobs: NEXT_DEFINITIONS,
});
const NEXT_DIGEST = canonicalJsonSha256(
  {
    domain: 'aquaculture.feeding-job-catalog',
    schemaVersion: 'feeding-job-catalog/v2',
  },
  createCanonicalJsonDocumentV1(JSON.parse(NEXT_CANONICAL_JSON) as unknown),
);

function strictJson(value: unknown): string {
  return canonicalJsonStringify(createCanonicalJsonDocumentV1(value));
}

function nestedResultPayload(depth: number, leaf: unknown = 'portable'): unknown {
  let payload = leaf;
  for (let level = 0; level < depth; level += 1) payload = { value: payload };
  return payload;
}

function admissionEvidence(
  actor: string,
  operationId: string,
  generation: number,
  digest = FEEDING_JOB_CATALOG_DIGEST,
  revision = FEEDING_JOB_CATALOG_REVISION,
  jobCount = FEEDING_JOB_CATALOG.length,
): string {
  return strictJson({
    actor,
    operationId,
    reason: 'release_convergence',
    catalogRevision: revision,
    catalogDigest: digest,
    catalogJobCount: jobCount,
    admissionGeneration: generation,
  });
}

interface SchedulerCutRow {
  rowKind: 'task';
  catalogJob: string;
  tenantId: string;
  targetKind: 'site';
  targetId: string;
  timezone: string;
  authorityGeneration: string;
  catalogDigest: string;
  catalogAdmissionGeneration: string;
  timezoneSource: string;
  targetSetDigest: string;
  observedAt: Date;
  cutDigest: string;
}

function scheduledIntent(
  envelope: ReturnType<typeof createFeedingScheduledDispatchEnvelope>,
  cut: SchedulerCutRow,
): string {
  return strictJson({
    schemaVersion: 'feeding-operation-intent/v1',
    tenantId: TENANT_ID,
    actorId: null,
    requestId: null,
    jobId: envelope.jobId,
    targetKind: 'site',
    targetId: envelope.targetId,
    siteId: envelope.targetId,
    unitId: null,
    reason: 'scheduled_reconciliation',
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    commandDigest: envelope.commandDigest,
    commandPayload: {
      jobId: envelope.jobId,
      tenantId: TENANT_ID,
      siteId: envelope.targetId,
    },
    lockSetDigest: compileFeedingOperationLockSetDigestV1({
      tenantId: TENANT_ID,
      jobId: envelope.jobId,
      targetKind: 'site',
      targetId: envelope.targetId,
      localDate: envelope.localDate,
    }),
    observedAt: envelope.observedAt,
    dueAt: envelope.dueAt,
    scheduleKey: envelope.scheduleKey,
    localDate: envelope.localDate,
    timezone: cut.timezone,
    caughtUp: envelope.caughtUp,
    dstGapAdjusted: envelope.dstGapAdjusted,
    timezoneSource: cut.timezoneSource,
    catalogAdmissionGeneration: Number(cut.catalogAdmissionGeneration),
    authorityGeneration: Number(cut.authorityGeneration),
    targetSetDigest: cut.targetSetDigest,
    schedulerCutDigest: cut.cutDigest,
    dispatchDigest: envelope.dispatchDigest,
  });
}

interface ManualIntentCoordinatesV1 {
  readonly requestId: string;
  readonly targetId: string;
  readonly commandDigest: string;
  readonly observedAt: string;
  readonly dueAt: string;
  readonly localDate: string;
  readonly timezone: string;
}

function manualCommandPayload(
  requestId: string,
  targetId: string,
): ForecastRefreshOperationCommand & Readonly<Record<string, CanonicalJsonValue>> {
  return {
    jobId: 'v2.forecast.refresh',
    tenantId: TENANT_ID,
    siteId: targetId,
    actorId: 'operator-1',
    requestId,
    emitCoverageEvents: false,
  };
}

function manualCommandDigest(requestId: string, targetId: string): string {
  return feedingOperationCommandDigestV1(manualCommandPayload(requestId, targetId));
}

function manualIntent(coordinates: ManualIntentCoordinatesV1): string {
  const commandPayload = manualCommandPayload(coordinates.requestId, coordinates.targetId);
  if (feedingOperationCommandDigestV1(commandPayload) !== coordinates.commandDigest) {
    throw new Error('manual intent fixture command digest differs from its canonical payload');
  }
  return strictJson({
    schemaVersion: 'feeding-operation-intent/v1',
    tenantId: TENANT_ID,
    actorId: 'operator-1',
    requestId: coordinates.requestId,
    jobId: 'v2.forecast.refresh',
    targetKind: 'site',
    targetId: coordinates.targetId,
    siteId: coordinates.targetId,
    unitId: null,
    reason: 'operator_request',
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    commandDigest: coordinates.commandDigest,
    commandPayload,
    lockSetDigest: compileFeedingOperationLockSetDigestV1({
      tenantId: TENANT_ID,
      jobId: 'v2.forecast.refresh',
      targetKind: 'site',
      targetId: coordinates.targetId,
      localDate: coordinates.localDate,
    }),
    observedAt: coordinates.observedAt,
    dueAt: coordinates.dueAt,
    scheduleKey: coordinates.requestId,
    localDate: coordinates.localDate,
    timezone: coordinates.timezone,
    caughtUp: false,
    dstGapAdjusted: false,
    timezoneSource: 'tenant_site_catalog',
    catalogAdmissionGeneration: null,
    authorityGeneration: null,
    targetSetDigest: null,
    schedulerCutDigest: null,
    dispatchDigest: null,
  });
}

const TENANT_SCHEMA = 'tenant_1111111111114111';

function freshIntervalObservation(): Date {
  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const minuteWithinInterval = Math.floor(currentMinute / 60_000) % 15;
  return new Date(currentMinute + (minuteWithinInterval === 0 ? 90_000 : 30_000));
}

describe('feeding operation catalog and mutation authority', () => {
  let postgres: HarnessContext | undefined;
  let queryRunner: QueryRunner | undefined;

  function runner(): QueryRunner {
    if (!queryRunner) throw new Error('feeding authority test query runner is not initialized');
    return queryRunner;
  }

  async function queryAsRole<T>(
    role: string,
    savepoint: string,
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<T> {
    const ownsTransaction = !runner().isTransactionActive;
    if (ownsTransaction) await runner().startTransaction();
    await runner().query(`SET ROLE ${role}`);
    await runner().query(`SAVEPOINT ${savepoint}`);
    let roleReset = false;
    let savepointReleased = false;
    try {
      const result: T = await runner().query(sql, [...parameters]);
      await runner().query(`RESET ROLE`);
      roleReset = true;
      await runner().query(`RELEASE SAVEPOINT ${savepoint}`);
      savepointReleased = true;
      if (ownsTransaction) await runner().commitTransaction();
      return result;
    } catch (error: unknown) {
      if (!savepointReleased) await runner().query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!roleReset) await runner().query(`RESET ROLE`);
      if (ownsTransaction && runner().isTransactionActive) await runner().rollbackTransaction();
      throw error;
    }
  }

  async function compileSchedulerCut(
    observedAt = freshIntervalObservation(),
    jobId = 'v2.meal-window.sweep',
  ): Promise<SchedulerCutRow> {
    const rows = await queryAsRole<SchedulerCutRow[]>(
      FEEDING_SCHEDULER_ROLE,
      'compile_scheduler_cut_role',
      `SELECT "rowKind", "catalogJob", "tenantId"::text AS "tenantId", "targetKind",
                "targetId"::text AS "targetId",
                timezone, "authorityGeneration"::text AS "authorityGeneration",
                "catalogDigest", "catalogAdmissionGeneration"::text AS "catalogAdmissionGeneration",
                "timezoneSource", "targetSetDigest", "observedAt", "cutDigest"
           FROM farm.compile_feeding_scheduler_cut($1, $2, $3::timestamptz)
          WHERE "rowKind" = 'task' AND "catalogJob" = $4`,
      [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST, observedAt, jobId],
    );
    expect(rows).toHaveLength(1);
    const cut = rows[0];
    if (!cut) throw new Error('scheduler compiler returned no cut');
    return cut;
  }

  function mealWindowDispatch(cut: SchedulerCutRow): {
    readonly commandDigest: string;
    readonly envelope: ReturnType<typeof createFeedingScheduledDispatchEnvelope>;
  } {
    const commandDigest = feedingScheduledCommandDigest('v2.meal-window.sweep', TENANT_ID, {
      targetKind: 'site',
      targetId: SITE_ID,
    });
    const occurrence = feedingDueOccurrences(
      feedingJobDefinition('v2.meal-window.sweep'),
      cut.observedAt,
      compileFeedingTimezone(cut.timezone),
    ).at(-1);
    if (!occurrence) throw new Error('meal-window test cut has no due occurrence');
    const envelope = createFeedingScheduledDispatchEnvelope({
      jobId: 'v2.meal-window.sweep',
      tenantId: TENANT_ID,
      target: { targetKind: 'site', targetId: SITE_ID },
      cut: {
        schemaVersion: 'feeding-scheduler-cut/v1',
        observedAt: cut.observedAt,
        catalogRevision: FEEDING_JOB_CATALOG_REVISION,
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        catalogAdmissionGeneration: Number(cut.catalogAdmissionGeneration),
        authorityGeneration: Number(cut.authorityGeneration),
        timezoneSource: 'tenant_site_catalog',
        timezone: compileFeedingTimezone(cut.timezone),
        targetSetDigest: cut.targetSetDigest,
        cutDigest: cut.cutDigest,
      },
      occurrence,
    });
    return { commandDigest, envelope };
  }

  async function enqueueDispatch(
    envelope: unknown,
  ): Promise<Array<{ disposition: string; coordinateKind: string; coordinateId: string }>> {
    return queryAsRole(
      FEEDING_SCHEDULER_ROLE,
      'enqueue_dispatch_role',
      `SELECT * FROM farm.enqueue_feeding_schedule_dispatch($1::jsonb)`,
      [strictJson(envelope)],
    );
  }

  async function claimDispatch(
    workerId = 'farm-service/00000000-0000-4000-8000-000000000001',
  ): Promise<
    Array<{
      dispatchId: string;
      leaseToken: string;
      envelope: Record<string, unknown>;
    }>
  > {
    return queryAsRole<
      Array<{
        dispatchId: string;
        leaseToken: string;
        envelope: Record<string, unknown>;
      }>
    >(
      FEEDING_RUNTIME_ROLE,
      'claim_dispatch_role',
      `SELECT "dispatchId", "leaseToken", envelope
           FROM farm.claim_feeding_schedule_dispatch($1::varchar)`,
      [workerId],
    );
  }

  async function leaseMealWindowDispatch(cut: SchedulerCutRow): Promise<{
    readonly commandDigest: string;
    readonly envelope: ReturnType<typeof createFeedingScheduledDispatchEnvelope>;
    readonly dispatchId: string;
    readonly leaseToken: string;
  }> {
    const { commandDigest, envelope } = mealWindowDispatch(cut);
    await enqueueDispatch(envelope);
    const claimed = await claimDispatch();
    expect(claimed).toHaveLength(1);
    const claim = claimed[0];
    if (!claim) throw new Error('scheduler dispatch claim returned no lease');
    return {
      commandDigest,
      envelope,
      dispatchId: claim.dispatchId,
      leaseToken: claim.leaseToken,
    };
  }

  beforeAll(async () => {
    postgres = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    queryRunner = postgres.dataSource.createQueryRunner();
    await runner().connect();
    await runner().query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await runner().query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await runner().query(`CREATE SCHEMA farm`);
    await runner().query(`CREATE SCHEMA admin`);
    await runner().query(`CREATE SCHEMA platform`);
    await runner().query(`CREATE ROLE farm_schema_owner NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await runner().query(`CREATE ROLE farm_service NOLOGIN`);
    await runner().query(`CREATE ROLE farm_feeding_scheduler LOGIN NOSUPERUSER NOBYPASSRLS`);
    await runner().query(`CREATE ROLE db_migrate NOLOGIN`);
    await runner().query(
      `GRANT farm_schema_owner, db_migrate, farm_service, farm_feeding_scheduler TO CURRENT_USER`,
    );
    await runner().query(`ALTER SCHEMA farm OWNER TO farm_schema_owner`);
    await runner().query(`GRANT USAGE ON SCHEMA farm TO farm_service`);
    await runner().query(`
      CREATE TABLE admin.tenant_schemas (
        "tenantId" uuid PRIMARY KEY,
        "schemaName" text NOT NULL UNIQUE,
        status varchar(32) NOT NULL,
        metadata jsonb NOT NULL
      )
    `);
    await runner().query(
      `INSERT INTO admin.tenant_schemas ("tenantId", "schemaName", status, metadata)
       VALUES (
         $1, $2, 'active',
         '{"operationId":"bootstrap","schemaExists":true,"committedProof":true}'::jsonb
       )`,
      [TENANT_ID, TENANT_SCHEMA],
    );
    await runner().query(`GRANT SELECT ON admin.tenant_schemas TO db_migrate`);
    await runner().query(`GRANT USAGE ON SCHEMA admin TO db_migrate`);
    await runner().query(`CREATE SCHEMA ${TENANT_SCHEMA}`);
    await runner().query(`GRANT USAGE ON SCHEMA ${TENANT_SCHEMA} TO farm_schema_owner`);
    await runner().query(`
      CREATE TABLE ${TENANT_SCHEMA}.sites (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        timezone varchar(64) NOT NULL,
        "isActive" boolean NOT NULL,
        "isDeleted" boolean NOT NULL
      )
    `);
    await runner().query(
      `INSERT INTO ${TENANT_SCHEMA}.sites
         (id, "tenantId", timezone, "isActive", "isDeleted")
       VALUES ($1, $2, 'Europe/Oslo', true, false)`,
      [SITE_ID, TENANT_ID],
    );
    await runner().query(`ALTER TABLE ${TENANT_SCHEMA}.sites OWNER TO farm_schema_owner`);
    await runner().query(`ALTER TABLE ${TENANT_SCHEMA}.sites ENABLE ROW LEVEL SECURITY`);
    await runner().query(`ALTER TABLE ${TENANT_SCHEMA}.sites FORCE ROW LEVEL SECURITY`);
    await runner().query(`
      CREATE POLICY tenant_sites_isolation ON ${TENANT_SCHEMA}.sites
      USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    `);
    await runner().query(`
      CREATE FUNCTION platform.list_active_tenant_schema_mappings()
      RETURNS TABLE(
        schema_name text,
        tenant_id uuid,
        schema_exists boolean,
        committed_proof boolean
      )
      LANGUAGE sql
      SECURITY DEFINER
      STABLE
      SET search_path = pg_catalog, pg_temp
      AS $body$
        SELECT tenant."schemaName", tenant."tenantId",
               COALESCE(
                 (tenant.metadata->>'schemaExists')::boolean,
                 pg_catalog.to_regnamespace(tenant."schemaName") IS NOT NULL
               ),
               COALESCE((tenant.metadata->>'committedProof')::boolean, false)
          FROM admin.tenant_schemas tenant
         WHERE tenant.status = 'active'
        UNION ALL
        SELECT tenant."schemaName", tenant."tenantId", true, true
          FROM admin.tenant_schemas tenant
         WHERE tenant.status = 'active'
           AND COALESCE((tenant.metadata->>'duplicate')::boolean, false)
         ORDER BY 1
      $body$
    `);
    await runner().query(
      `ALTER FUNCTION platform.list_active_tenant_schema_mappings() OWNER TO db_migrate`,
    );
    await runner().query(
      `REVOKE ALL ON FUNCTION platform.list_active_tenant_schema_mappings() FROM PUBLIC`,
    );
    await runner().query(
      `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO farm_service`,
    );
    for (const MigrationTarget of FEEDING_FIXED_CONTROL_PLANE_MIGRATIONS) {
      await new MigrationTarget().up(runner());
    }
  });

  afterAll(async () => {
    if (queryRunner) await queryRunner.release();
    if (postgres) await shutdownHarness(postgres);
  });

  it('persists scheduler sweep evidence and derives readiness from the durable heartbeat', async () => {
    const before: Array<{ healthy: boolean; generation: string | null }> = await queryAsRole(
      FEEDING_SCHEDULER_ROLE,
      'read_empty_scheduler_health',
      `SELECT healthy, generation::text AS generation
         FROM farm.read_feeding_scheduler_health(clock_timestamp())`,
    );
    expect(before).toEqual([{ healthy: false, generation: null }]);

    const dispositions = {
      enqueued: 0,
      idempotent: 0,
      business_slot_preserved: 0,
      already_completed: 0,
      already_running: 0,
      quarantined: 0,
    };
    const successEvidence = {
      schemaVersion: 'feeding-schedule-sweep-evidence/v1',
      status: 'succeeded',
      observedAt: '2026-08-08T12:00:00.000Z',
      stage: 'complete',
      cutDigest: 'a'.repeat(64),
      dueCount: 0,
      dispositions,
      failureDigests: [],
    };
    const recorded: Array<{
      generation: string;
      status: string;
      stage: string;
      recordedAt: Date;
      readyBacklogCount: string;
      delayedBacklogCount: string;
      leasedBacklogCount: string;
      quarantinedCount: string;
      rejectedCount: string;
    }> = await queryAsRole(
      FEEDING_SCHEDULER_ROLE,
      'record_successful_scheduler_sweep',
      `SELECT generation::text AS generation, status, stage, "recordedAt",
              "readyBacklogCount"::text AS "readyBacklogCount",
              "delayedBacklogCount"::text AS "delayedBacklogCount",
              "leasedBacklogCount"::text AS "leasedBacklogCount",
              "quarantinedCount"::text AS "quarantinedCount",
              "rejectedCount"::text AS "rejectedCount"
         FROM farm.record_feeding_scheduler_sweep($1::jsonb)`,
      [JSON.stringify(successEvidence)],
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        generation: '1',
        status: 'succeeded',
        stage: 'complete',
        readyBacklogCount: '0',
        delayedBacklogCount: '0',
        leasedBacklogCount: '0',
        quarantinedCount: '0',
        rejectedCount: '0',
      }),
    ]);
    const recordedAt = recorded[0]?.recordedAt;
    if (!recordedAt) throw new Error('scheduler heartbeat did not return recordedAt');

    const fresh: Array<{ healthy: boolean; generation: string; heartbeatAgeSeconds: string }> =
      await queryAsRole(
        FEEDING_SCHEDULER_ROLE,
        'read_fresh_scheduler_health',
        `SELECT healthy, generation::text AS generation,
                "heartbeatAgeSeconds"::text AS "heartbeatAgeSeconds"
           FROM farm.read_feeding_scheduler_health(
             $1::timestamptz + interval '1 millisecond'
           )`,
        [recordedAt],
      );
    expect(fresh).toEqual([{ healthy: true, generation: '1', heartbeatAgeSeconds: '0' }]);

    const stale: Array<{ healthy: boolean; heartbeatAgeSeconds: string }> = await queryAsRole(
      FEEDING_SCHEDULER_ROLE,
      'read_stale_scheduler_health',
      `SELECT healthy, "heartbeatAgeSeconds"::text AS "heartbeatAgeSeconds"
         FROM farm.read_feeding_scheduler_health($1::timestamptz + interval '181.001 seconds')`,
      [recordedAt],
    );
    expect(stale).toEqual([{ healthy: false, heartbeatAgeSeconds: '181' }]);

    await expect(
      queryAsRole(
        FEEDING_SCHEDULER_ROLE,
        'reject_invalid_scheduler_evidence',
        `SELECT * FROM farm.record_feeding_scheduler_sweep($1::jsonb)`,
        [JSON.stringify({ ...successEvidence, failureDigests: ['not-a-digest'] })],
      ),
    ).rejects.toThrow(/closed contract/i);

    const failureEvidence = {
      ...successEvidence,
      status: 'failed',
      stage: 'compile',
      cutDigest: null,
      failureDigests: ['b'.repeat(64)],
    };
    const failed: Array<{ generation: string; status: string; stage: string }> = await queryAsRole(
      FEEDING_SCHEDULER_ROLE,
      'record_failed_scheduler_sweep',
      `SELECT generation::text AS generation, status, stage
         FROM farm.record_feeding_scheduler_sweep($1::jsonb)`,
      [JSON.stringify(failureEvidence)],
    );
    expect(failed).toEqual([{ generation: '2', status: 'failed', stage: 'compile' }]);

    const unhealthy: Array<{ healthy: boolean; generation: string; status: string }> =
      await queryAsRole(
        FEEDING_SCHEDULER_ROLE,
        'read_failed_scheduler_health',
        `SELECT healthy, generation::text AS generation, status
           FROM farm.read_feeding_scheduler_health(clock_timestamp())`,
      );
    expect(unhealthy).toEqual([{ healthy: false, generation: '2', status: 'failed' }]);

    await expect(
      queryAsRole(
        FEEDING_SCHEDULER_ROLE,
        'deny_scheduler_heartbeat_table_read',
        `SELECT * FROM farm.feeding_scheduler_heartbeat`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('mirrors the TypeScript result preimage byte-for-byte and binds its schema', async () => {
    const resultSchema = 'feeding-operation-result/v2.forecast.refresh/v1';
    const artifact = compileFeedingResultArtifactV1(resultSchema, {
      z: 2,
      refreshedCount: 3,
      a: 'ok',
    });
    const rows: Array<{ preimage: string; digest: string; otherSchemaDigest: string }> =
      await runner().query(
        `SELECT
           farm.feeding_result_hash_preimage($1, $2) AS preimage,
           farm.feeding_result_digest($1, $2) AS digest,
           farm.feeding_result_digest($3, $2) AS "otherSchemaDigest"`,
        [
          resultSchema,
          artifact.payloadJson,
          'feeding-operation-result/manual.day-plan.regenerate/v1',
        ],
      );

    expect(rows).toEqual([
      {
        preimage: artifact.hashPreimage,
        digest: artifact.digest,
        otherSchemaDigest: expect.not.stringMatching(artifact.digest),
      },
    ]);

    const adversarial: Array<{
      payload: string;
      vocabulary: boolean;
      canonical: boolean;
      accepted: boolean;
    }> = await runner().query(
      `SELECT payload,
              farm.is_valid_feeding_result_payload(payload::jsonb) AS vocabulary,
              payload = farm.canonical_feeding_json(payload::jsonb) AS canonical,
              farm.is_valid_feeding_result_payload(payload::jsonb)
                AND payload = farm.canonical_feeding_json(payload::jsonb) AS accepted
         FROM pg_catalog.unnest($1::text[]) AS candidate(payload)`,
      [
        [
          '{"fraction":0.000001,"unicodeValue":"balık 🐟"}',
          '{"fraction":1e-7}',
          '{"negativeZero":-0}',
          '{"large":9007199254740992}',
          '{"ünicodeKey":"rejected"}',
          '{"fraction":1.250}',
        ],
      ],
    );
    expect(adversarial).toEqual([
      {
        payload: '{"fraction":0.000001,"unicodeValue":"balık 🐟"}',
        vocabulary: true,
        canonical: true,
        accepted: true,
      },
      {
        payload: '{"fraction":1e-7}',
        vocabulary: false,
        canonical: false,
        accepted: false,
      },
      {
        payload: '{"negativeZero":-0}',
        vocabulary: true,
        canonical: false,
        accepted: false,
      },
      {
        payload: '{"large":9007199254740992}',
        vocabulary: false,
        canonical: true,
        accepted: false,
      },
      {
        payload: '{"ünicodeKey":"rejected"}',
        vocabulary: false,
        canonical: true,
        accepted: false,
      },
      {
        payload: '{"fraction":1.250}',
        vocabulary: true,
        canonical: false,
        accepted: false,
      },
    ]);

    const boundaryPayloadJson = JSON.stringify(
      nestedResultPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth),
    );
    const overDepthPayloadJson = JSON.stringify(
      nestedResultPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth + 1),
    );
    expect(
      compileFeedingResultArtifactV1(
        resultSchema,
        nestedResultPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth),
      ).payloadJson,
    ).toBe(boundaryPayloadJson);
    expect(() =>
      compileFeedingResultArtifactV1(
        resultSchema,
        nestedResultPayload(FEEDING_RESULT_PORTABILITY_V1.maxDepth + 1),
      ),
    ).toThrow(/depth limit/);

    const depthRows: Array<{ payloadDepth: number; accepted: boolean }> = await runner().query(
      `SELECT $2::integer + candidate.ordinality::integer - 1 AS "payloadDepth",
              farm.is_valid_feeding_result_payload(candidate.payload::jsonb) AS accepted
         FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS candidate(payload, ordinality)
        ORDER BY candidate.ordinality`,
      [[boundaryPayloadJson, overDepthPayloadJson], FEEDING_RESULT_PORTABILITY_V1.maxDepth],
    );
    expect(depthRows).toEqual([
      { payloadDepth: FEEDING_RESULT_PORTABILITY_V1.maxDepth, accepted: true },
      { payloadDepth: FEEDING_RESULT_PORTABILITY_V1.maxDepth + 1, accepted: false },
    ]);

    const nul = String.fromCharCode(0);
    const nulPayloadJson = JSON.stringify({ nested: [`before${nul}after`] });
    expect(() =>
      compileFeedingResultArtifactV1(resultSchema, { nested: [`before${nul}after`] }),
    ).toThrow(/non-portable NUL string/);
    await expect(
      runner().query(`SELECT farm.is_valid_feeding_result_payload($1::jsonb)`, [nulPayloadJson]),
    ).rejects.toMatchObject({ code: '22P05' });

    for (const invalidScalar of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      const invalidScalarPayload = { nested: [`before${invalidScalar}after`] };
      expect(() => compileFeedingResultArtifactV1(resultSchema, invalidScalarPayload)).toThrow(
        /CANONICAL_JSON_INVALID_UNICODE/,
      );
      await expect(
        runner().query(`SELECT farm.is_valid_feeding_result_payload($1::jsonb)`, [
          JSON.stringify(invalidScalarPayload),
        ]),
      ).rejects.toMatchObject({ code: '22P02' });
    }
  });

  it('rejects an existing partial artifact instead of repairing it', async () => {
    await runner().startTransaction();
    try {
      await runner().query(
        `INSERT INTO farm.feeding_catalog_revisions (
           digest, revision, "canonicalJson", "jobCount"
         ) VALUES ($1, $2, $3, $4)`,
        [
          FEEDING_JOB_CATALOG_DIGEST,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_CANONICAL_JSON,
          FEEDING_JOB_CATALOG.length,
        ],
      );
      const first = FEEDING_JOB_CATALOG[0];
      if (!first) throw new Error('governed feeding catalog is unexpectedly empty');
      await runner().query(
        `INSERT INTO farm.feeding_job_catalog_entries (
           "catalogDigest", id, capability, "scheduleKind", "clockProfile",
           "targetCardinality", "timezoneSource",
           "leaseSeconds", enabled, definition
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          FEEDING_JOB_CATALOG_DIGEST,
          first.id,
          first.capability,
          first.scheduleKind,
          first.clockProfile,
          first.targetCardinality,
          first.timezoneSource,
          first.leaseSeconds,
          first.enabled,
          JSON.stringify(first),
        ],
      );

      await expect(projectFeedingJobCatalog(runner())).rejects.toThrow(
        /immutable catalog artifact set equality failed/i,
      );
      await expect(
        runner().query(
          `SELECT farm.admit_feeding_catalog(NULL, NULL, $1, 'partial-test', $2::jsonb)`,
          [FEEDING_JOB_CATALOG_DIGEST, admissionEvidence('partial-test', 'partial-test', 1)],
        ),
      ).rejects.toThrow(/not an exact canonical set/i);
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('publishes exact immutable bytes and admits the digest idempotently', async () => {
    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'release-1',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();

    const roots: Array<{
      digest: string;
      revision: string;
      canonicalJson: string;
      jobCount: number;
      projectedAt: Date;
    }> = await runner().query(
      `SELECT digest::text AS digest, revision, "canonicalJson",
              "jobCount", "projectedAt"
         FROM farm.feeding_catalog_revisions`,
    );
    expect(roots).toEqual([
      expect.objectContaining({
        digest: FEEDING_JOB_CATALOG_DIGEST,
        revision: FEEDING_JOB_CATALOG_REVISION,
        canonicalJson: FEEDING_JOB_CATALOG_CANONICAL_JSON,
        jobCount: FEEDING_JOB_CATALOG.length,
      }),
    ]);
    const beforeProjectedAt = roots[0]?.projectedAt;

    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'release-1-replay',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();

    const counts: Array<{ roots: number; entries: number; admissions: number }> =
      await runner().query(
        `SELECT
           (SELECT count(*)::int FROM farm.feeding_catalog_revisions) AS roots,
           (SELECT count(*)::int FROM farm.feeding_job_catalog_entries) AS entries,
           (SELECT count(*)::int FROM farm.feeding_catalog_admission_history) AS admissions`,
      );
    expect(counts).toEqual([{ roots: 1, entries: FEEDING_JOB_CATALOG.length, admissions: 1 }]);
    const after: Array<{ projectedAt: Date }> = await runner().query(
      `SELECT "projectedAt" FROM farm.feeding_catalog_revisions WHERE digest = $1`,
      [FEEDING_JOB_CATALOG_DIGEST],
    );
    expect(after[0]?.projectedAt).toEqual(beforeProjectedAt);
  });

  it('pins exact non-login ownership and least-privilege ACLs for every protected object', async () => {
    const roles: Array<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }> = await runner().query(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
         FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [
        [
          FEEDING_DATABASE_OWNER_ROLE,
          FEEDING_MIGRATION_ROLE,
          FEEDING_RUNTIME_ROLE,
          FEEDING_SCHEDULER_ROLE,
        ],
      ],
    );
    expect(roles).toHaveLength(4);
    expect(roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rolname: FEEDING_DATABASE_OWNER_ROLE,
          rolcanlogin: false,
          rolsuper: false,
          rolbypassrls: false,
        }),
        expect.objectContaining({ rolname: FEEDING_RUNTIME_ROLE, rolcanlogin: false }),
        expect.objectContaining({
          rolname: FEEDING_SCHEDULER_ROLE,
          rolcanlogin: true,
          rolsuper: false,
          rolbypassrls: false,
        }),
      ]),
    );

    for (const relation of FEEDING_CONTROL_PLANE_RELATIONS) {
      const rows: Array<{
        owner: string;
        runtimeSelect: boolean;
        runtimeInsert: boolean;
        runtimeUpdate: boolean;
        runtimeDelete: boolean;
      }> = await runner().query(
        `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
                pg_catalog.has_table_privilege($2, c.oid, 'SELECT') AS "runtimeSelect",
                pg_catalog.has_table_privilege($2, c.oid, 'INSERT') AS "runtimeInsert",
                pg_catalog.has_table_privilege($2, c.oid, 'UPDATE') AS "runtimeUpdate",
                pg_catalog.has_table_privilege($2, c.oid, 'DELETE') AS "runtimeDelete"
           FROM pg_catalog.pg_class c
          WHERE c.oid = $1::regclass`,
        [relation.name, FEEDING_RUNTIME_ROLE],
      );
      expect(rows).toEqual([
        {
          owner: FEEDING_DATABASE_OWNER_ROLE,
          runtimeSelect: false,
          runtimeInsert: false,
          runtimeUpdate: false,
          runtimeDelete: false,
        },
      ]);
    }
    for (const sequence of FEEDING_CONTROL_PLANE_SEQUENCES) {
      const rows: Array<{ owner: string; runtimeUsage: boolean }> = await runner().query(
        `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
                pg_catalog.has_sequence_privilege($2, c.oid, 'USAGE') AS "runtimeUsage"
           FROM pg_catalog.pg_class c
          WHERE c.oid = $1::regclass`,
        [sequence, FEEDING_RUNTIME_ROLE],
      );
      expect(rows).toEqual([{ owner: FEEDING_DATABASE_OWNER_ROLE, runtimeUsage: false }]);
    }

    const runtimeFunctions = new Set<string>(FEEDING_TENANT_RUNTIME_KERNEL_FUNCTIONS);
    const schedulerFunctions = new Set<string>(FEEDING_SCHEDULER_KERNEL_FUNCTIONS);
    const migrationFunctions = new Set<string>(FEEDING_MIGRATION_KERNEL_FUNCTIONS);
    for (const signature of [
      ...FEEDING_CONTROL_PLANE_HELPER_FUNCTIONS,
      ...FEEDING_CONTROL_PLANE_KERNEL_FUNCTIONS,
    ]) {
      const rows: Array<{
        owner: string;
        publicExecute: boolean;
        runtimeExecute: boolean;
        schedulerExecute: boolean;
        migrationExecute: boolean;
      }> = await runner().query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
                EXISTS (
                  SELECT 1
                    FROM pg_catalog.aclexplode(
                      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
                    ) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                ) AS "publicExecute",
                pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') AS "runtimeExecute",
                pg_catalog.has_function_privilege($3, p.oid, 'EXECUTE') AS "schedulerExecute",
                pg_catalog.has_function_privilege($4, p.oid, 'EXECUTE') AS "migrationExecute"
           FROM pg_catalog.pg_proc p
          WHERE p.oid = $1::regprocedure`,
        [signature, FEEDING_RUNTIME_ROLE, FEEDING_SCHEDULER_ROLE, FEEDING_MIGRATION_ROLE],
      );
      expect(rows).toEqual([
        {
          owner: FEEDING_DATABASE_OWNER_ROLE,
          publicExecute: false,
          runtimeExecute: runtimeFunctions.has(signature),
          schedulerExecute: schedulerFunctions.has(signature),
          migrationExecute: migrationFunctions.has(signature),
        },
      ]);
    }
  });

  it.each([
    [
      'missing physical schema',
      `metadata = metadata || '{"schemaExists":false}'::jsonb`,
      /no physical schema/i,
    ],
    [
      'uncommitted mapping',
      `metadata = metadata || '{"committedProof":false}'::jsonb`,
      /no matching committed operation/i,
    ],
    [
      'duplicate mapping',
      `metadata = metadata || '{"duplicate":true}'::jsonb`,
      /duplicate active mapping/i,
    ],
    [
      'schema identity mismatch',
      `"schemaName" = 'tenant_ffffffffffffffff', metadata = metadata || '{"schemaExists":true}'::jsonb`,
      /mapping mismatch/i,
    ],
  ])('rejects %s before writer authority reconciliation', async (_label, mutation, expected) => {
    await runner().startTransaction();
    try {
      await runner().query(`UPDATE admin.tenant_schemas SET ${mutation} WHERE "tenantId" = $1`, [
        TENANT_ID,
      ]);
      await expect(
        reconcileFeedingWriterAuthorities(runner(), {
          actor: 'mapping-failure-test',
          operationId: `mapping-${String(_label).replaceAll(' ', '-')}`,
          reason: 'tenant_reconcile',
        }),
      ).rejects.toThrow(expected as RegExp);
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('rejects overwrite, delete, and extra-entry corruption', async () => {
    await expect(
      runner().query(
        `INSERT INTO farm.feeding_catalog_revisions (
           digest, revision, "canonicalJson", "jobCount"
         ) VALUES ($1, $2, $3, $4)`,
        [
          'a'.repeat(64),
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_CANONICAL_JSON,
          FEEDING_JOB_CATALOG.length,
        ],
      ),
    ).rejects.toThrow(/CHK_feeding_catalog_root_digest/i);
    await expect(
      runner().query(
        `UPDATE farm.feeding_job_catalog_entries
            SET enabled = false
          WHERE "catalogDigest" = $1 AND id = 'v2.day-plan.generate'`,
        [FEEDING_JOB_CATALOG_DIGEST],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      runner().query(`DELETE FROM farm.feeding_catalog_revisions WHERE digest = $1`, [
        FEEDING_JOB_CATALOG_DIGEST,
      ]),
    ).rejects.toThrow(/append-only/i);

    await expect(
      runner().query(
        `INSERT INTO farm.feeding_job_catalog_entries (
           "catalogDigest", id, capability, "scheduleKind", "clockProfile",
           "targetCardinality", "timezoneSource",
           "leaseSeconds", enabled, definition
         ) VALUES (
           $1, 'unexpected.job', 'scheduled.v2', 'on_demand',
           'site_local', 'operation_target', 'tenant_site_catalog',
           60, true, '{"id":"unexpected.job"}'::jsonb
        )`,
        [FEEDING_JOB_CATALOG_DIGEST],
      ),
    ).rejects.toThrow(/sealed by admission/i);
  });

  it('projects legitimate zero-target site jobs without hiding or failing the catalog cut', async () => {
    const observedAt = new Date('2026-08-05T04:00:00.000Z');
    await runner().startTransaction();
    try {
      await runner().query(
        `UPDATE ${TENANT_SCHEMA}.sites SET "isActive" = false WHERE "tenantId" = $1`,
        [TENANT_ID],
      );
      await runner().query(`SET ROLE ${FEEDING_SCHEDULER_ROLE}`);
      let rows: Array<{
        rowKind: 'job_projection' | 'task';
        catalogJob: string;
        jobTargetCount: number | null;
        tenantId: string | null;
      }>;
      try {
        rows = await runner().query(
          `SELECT "rowKind", "catalogJob", "jobTargetCount",
                  "tenantId"::text AS "tenantId"
             FROM farm.compile_feeding_scheduler_cut($1, $2, $3::timestamptz)`,
          [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST, observedAt],
        );
      } finally {
        await runner().query(`RESET ROLE`);
      }
      const projections = new Map(
        rows
          .filter((row) => row.rowKind === 'job_projection')
          .map((row) => [row.catalogJob, row.jobTargetCount]),
      );
      expect([...projections.keys()].sort()).toEqual([...FEEDING_SCHEDULED_JOB_IDS].sort());
      for (const jobId of FEEDING_SITE_SCHEDULED_JOB_IDS) {
        expect(projections.get(jobId)).toBe(0);
      }
      for (const jobId of FEEDING_TENANT_SCHEDULED_JOB_IDS) {
        expect(projections.get(jobId)).toBe(1);
      }
      expect(rows.filter((row) => row.rowKind === 'task').map((row) => row.catalogJob)).toEqual(
        [...FEEDING_TENANT_SCHEDULED_JOB_IDS].sort(),
      );
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('distinguishes a canonical empty scheduler cut from an unavailable authority', async () => {
    const observedAt = new Date('2026-08-05T04:00:00.000Z');
    await runner().startTransaction();
    try {
      await runner().query(
        `UPDATE admin.tenant_schemas SET status = 'deleted' WHERE "tenantId" = $1`,
        [TENANT_ID],
      );
      await reconcileFeedingWriterAuthorities(runner(), {
        actor: 'empty-cut-test',
        operationId: 'empty-cut-test',
        reason: 'tenant_reconcile',
      });
      await runner().query(`SET ROLE ${FEEDING_SCHEDULER_ROLE}`);
      let rows: Array<{
        rowKind: 'job_projection';
        catalogJob: string;
        jobTargetCount: number;
        jobTargetRoot: string;
        tenantId: string | null;
        cutDigest: string;
      }>;
      try {
        rows = await runner().query(
          `SELECT "rowKind", "catalogJob", "jobTargetCount", "jobTargetRoot",
                  "tenantId", "cutDigest"
             FROM farm.compile_feeding_scheduler_cut($1, $2, $3::timestamptz)`,
          [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST, observedAt],
        );
      } finally {
        await runner().query(`RESET ROLE`);
      }
      const jobProjections = [...FEEDING_SCHEDULED_JOB_IDS].sort().map((catalogJob) => ({
        catalogJob,
        jobTargetCount: 0,
        jobTargetRoot: canonicalJsonSha256(
          {
            domain: 'aquaculture.feeding-scheduler-job-target-projection',
            schemaVersion: 'feeding-scheduler-job-target-projection/v1',
          },
          createCanonicalJsonDocumentV1({ catalogJob, targets: [] }),
        ),
      }));
      const cutDigest = canonicalJsonSha256(
        {
          domain: 'aquaculture.feeding-scheduler-target-cut',
          schemaVersion: 'feeding-scheduler-target-cut/v1',
        },
        createCanonicalJsonDocumentV1({
          schemaVersion: 'feeding-scheduler-target-cut/v1',
          catalogRevision: FEEDING_JOB_CATALOG_REVISION,
          catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
          observedAt: observedAt.toISOString(),
          jobProjections,
          tasks: [],
        }),
      );
      expect(rows).toEqual(
        jobProjections.map((projection) => ({
          rowKind: 'job_projection',
          ...projection,
          tenantId: null,
          cutDigest,
        })),
      );

      await runner().query(`REVOKE EXECUTE ON FUNCTION farm.compile_feeding_scheduler_cut(
        varchar, varchar, timestamptz
      ) FROM ${FEEDING_SCHEDULER_ROLE}`);
      await runner().query(`SET ROLE ${FEEDING_SCHEDULER_ROLE}`);
      await runner().query(`SAVEPOINT unavailable_scheduler_authority`);
      try {
        await expect(
          runner().query(
            `SELECT * FROM farm.compile_feeding_scheduler_cut($1, $2, $3::timestamptz)`,
            [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST, observedAt],
          ),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await runner().query(`ROLLBACK TO SAVEPOINT unavailable_scheduler_authority`);
        await runner().query(`RESET ROLE`);
      }
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('rejects a fabricated scheduled command without an exact leased dispatch', async () => {
    await runner().startTransaction();
    try {
      const cut = await compileSchedulerCut();
      const { commandDigest, envelope } = mealWindowDispatch(cut);
      await runner().query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_ID]);
      await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
      await runner().query(`SAVEPOINT fabricated_schedule_claim`);
      try {
        await expect(
          runner().query(
            `SELECT * FROM farm.claim_feeding_job(
               $1::uuid, 'v2.meal-window.sweep', $3, $4::date,
               $5, 'tenant_site_catalog', 'site_local', 'site', $2::uuid,
               $6, $7, $8, $9::bigint, $10::bigint, $11, $12::jsonb
             )`,
            [
              TENANT_ID,
              SITE_ID,
              envelope.scheduleKey,
              envelope.localDate,
              envelope.timezone,
              FEEDING_JOB_CATALOG_REVISION,
              FEEDING_JOB_CATALOG_DIGEST,
              commandDigest,
              Number(cut.catalogAdmissionGeneration),
              Number(cut.authorityGeneration),
              cut.targetSetDigest,
              scheduledIntent(envelope, cut),
            ],
          ),
        ).rejects.toThrow(/no exact leased dispatch authority/i);
      } finally {
        await runner().query(`ROLLBACK TO SAVEPOINT fabricated_schedule_claim`);
        await runner().query(`RESET ROLE`);
      }
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('rejects a valid historical cut after its catalog capture freshness expires', async () => {
    await runner().startTransaction();
    try {
      const historicalObservedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
      const cut = await compileSchedulerCut(historicalObservedAt);
      const { envelope } = mealWindowDispatch(cut);
      await runner().query(`SET ROLE ${FEEDING_SCHEDULER_ROLE}`);
      await runner().query(`SAVEPOINT stale_capture_enqueue`);
      try {
        await expect(
          runner().query(`SELECT * FROM farm.enqueue_feeding_schedule_dispatch($1::jsonb)`, [
            strictJson(envelope),
          ]),
        ).rejects.toThrow(/outside catalog freshness/i);
      } finally {
        await runner().query(`ROLLBACK TO SAVEPOINT stale_capture_enqueue`);
        await runner().query(`RESET ROLE`);
      }
      const count: Array<{ count: number }> = await runner().query(
        `SELECT count(*)::int AS count
           FROM farm.feeding_schedule_dispatches
          WHERE "dispatchDigest" = $1`,
        [envelope.dispatchDigest],
      );
      expect(count).toEqual([{ count: 0 }]);
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('orders independently-enqueued catch-up slots by exact due instant', async () => {
    await runner().startTransaction();
    try {
      const observedAt = freshIntervalObservation();
      const cut = await compileSchedulerCut(observedAt, 'v2.meal-window.sweep');
      const definition = feedingJobDefinition('v2.meal-window.sweep');
      const occurrences = feedingDueOccurrences(
        definition,
        observedAt,
        compileFeedingTimezone(cut.timezone),
      );
      expect(occurrences).toHaveLength(2);
      const schedulerCut = {
        schemaVersion: 'feeding-scheduler-cut/v1' as const,
        observedAt,
        catalogRevision: FEEDING_JOB_CATALOG_REVISION,
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        catalogAdmissionGeneration: Number(cut.catalogAdmissionGeneration),
        authorityGeneration: Number(cut.authorityGeneration),
        timezoneSource: 'tenant_site_catalog' as const,
        timezone: compileFeedingTimezone(cut.timezone),
        targetSetDigest: cut.targetSetDigest,
        cutDigest: cut.cutDigest,
      };
      const envelopes = occurrences.map((occurrence) =>
        createFeedingScheduledDispatchEnvelope({
          jobId: 'v2.meal-window.sweep',
          tenantId: TENANT_ID,
          target: { targetKind: 'site', targetId: SITE_ID },
          cut: schedulerCut,
          occurrence,
        }),
      );
      for (const envelope of [...envelopes].reverse()) await enqueueDispatch(envelope);

      const claimedDueAt: string[] = [];
      for (let index = 0; index < envelopes.length; index += 1) {
        const claimed = await claimDispatch(
          `farm-service/10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        );
        expect(claimed).toHaveLength(1);
        const dueAt = claimed[0]?.envelope['dueAt'];
        if (typeof dueAt !== 'string') throw new Error('claimed dispatch omitted dueAt');
        claimedDueAt.push(dueAt);
      }
      expect(claimedDueAt).toEqual(
        occurrences.map((occurrence) => occurrence.dueAt.toISOString()).sort(),
      );
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('propagates compiler corruption and leaves a dispatch pending', async () => {
    await runner().startTransaction();
    try {
      const cut = await compileSchedulerCut();
      const { envelope } = mealWindowDispatch(cut);
      const enqueued = await enqueueDispatch(envelope);
      const dispatchId = enqueued[0]?.coordinateId;
      if (!dispatchId) throw new Error('fault-injection dispatch was not persisted');
      await runner().query(`ALTER TABLE ${TENANT_SCHEMA}.sites RENAME TO sites_fault_injected`);
      await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
      await runner().query(`SAVEPOINT feeding_dispatch_fault`);
      try {
        await expect(
          runner().query(
            `SELECT * FROM farm.claim_feeding_schedule_dispatch(
               'farm-service/20000000-0000-4000-8000-000000000001'
             )`,
          ),
        ).rejects.toThrow(/sites/i);
      } finally {
        await runner().query(`ROLLBACK TO SAVEPOINT feeding_dispatch_fault`);
        await runner().query(`RESET ROLE`);
      }
      const rows: Array<{ status: string; attempt: number }> = await runner().query(
        `SELECT status, attempt FROM farm.feeding_schedule_dispatches WHERE id = $1`,
        [dispatchId],
      );
      expect(rows).toEqual([{ status: 'pending', attempt: 0 }]);
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('applies catalog retry backoff and terminal quarantine without re-enqueue bypass', async () => {
    await runner().startTransaction();
    try {
      const cut = await compileSchedulerCut();
      const { envelope, dispatchId, leaseToken } = await leaseMealWindowDispatch(cut);
      let currentLeaseToken = leaseToken;
      for (
        let attempt = 1;
        attempt <= FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY.maxAttempts;
        attempt += 1
      ) {
        await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
        await runner().query(`SAVEPOINT retry_release`);
        try {
          const released: Array<{ accepted: boolean }> = await runner().query(
            `SELECT farm.release_feeding_schedule_dispatch(
               $1::uuid, $2::uuid, 'FEEDING_TEST_FAILURE', $3
             ) AS accepted`,
            [dispatchId, currentLeaseToken, 'a'.repeat(64)],
          );
          expect(released).toEqual([{ accepted: true }]);
          await runner().query(`RELEASE SAVEPOINT retry_release`);
        } catch (error: unknown) {
          await runner().query(`ROLLBACK TO SAVEPOINT retry_release`);
          throw error;
        } finally {
          await runner().query(`RESET ROLE`);
        }
        if (attempt < FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY.maxAttempts) {
          await runner().query(
            `UPDATE farm.feeding_schedule_dispatches
                SET "availableAt" = pg_catalog.clock_timestamp()
              WHERE id = $1`,
            [dispatchId],
          );
          const claimed = await claimDispatch(
            `farm-service/30000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`,
          );
          expect(claimed).toHaveLength(1);
          const next = claimed[0];
          if (!next) throw new Error('retry dispatch was not leased');
          currentLeaseToken = next.leaseToken;
        }
      }

      const state: Array<{ status: string; attempt: number }> = await runner().query(
        `SELECT status, attempt FROM farm.feeding_schedule_dispatches WHERE id = $1`,
        [dispatchId],
      );
      expect(state).toEqual([
        {
          status: FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY.terminalDisposition,
          attempt: FEEDING_SCHEDULE_DISPATCH_RETRY_POLICY.maxAttempts,
        },
      ]);
      const transitions: Array<{ backoffSeconds: number; terminalDisposition: string | null }> =
        await runner().query(
          `SELECT (evidence->>'backoffSeconds')::int AS "backoffSeconds",
                  evidence->>'terminalDisposition' AS "terminalDisposition"
             FROM farm.feeding_schedule_dispatch_transitions
            WHERE "dispatchId" = $1 AND transition IN ('released', 'quarantined')
            ORDER BY attempt`,
          [dispatchId],
        );
      expect(transitions.map((transition) => transition.backoffSeconds)).toEqual([
        30, 60, 120, 240, 480, 900, 900, 900,
      ]);
      expect(transitions.at(-1)?.terminalDisposition).toBe('quarantined');
      expect(await enqueueDispatch(envelope)).toEqual([
        { disposition: 'quarantined', coordinateKind: 'dispatch', coordinateId: dispatchId },
      ]);
      expect(await claimDispatch('farm-service/40000000-0000-4000-8000-000000000001')).toEqual([]);
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('rejects completion after its writer authority cut becomes stale', async () => {
    await runner().startTransaction();
    try {
      const cut = await compileSchedulerCut();
      const { dispatchId, leaseToken } = await leaseMealWindowDispatch(cut);
      await revokeFeedingWriterAuthority(runner(), TENANT_ID, {
        actor: 'stale-dispatch-test',
        operationId: 'stale-dispatch-test',
        reason: 'tenant_reconcile',
      });
      await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
      await runner().query(`SAVEPOINT stale_dispatch_completion`);
      try {
        await expect(
          runner().query(`SELECT farm.complete_feeding_schedule_dispatch($1, $2, $3)`, [
            dispatchId,
            leaseToken,
            '55555555-5555-4555-8555-555555555555',
          ]),
        ).rejects.toThrow(/lost its authority fence/i);
      } finally {
        await runner().query(`ROLLBACK TO SAVEPOINT stale_dispatch_completion`);
        await runner().query(`RESET ROLE`);
      }
    } finally {
      await runner().rollbackTransaction();
    }
  });

  it('preserves a run exact historical definition after the active pointer advances', async () => {
    await runner().query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT_ID]);
    const cut = await compileSchedulerCut();
    const { commandDigest, envelope } = await leaseMealWindowDispatch(cut);
    const claims: Array<{ operationId: string; leaseToken: string }> = await runner().query(
      `SELECT "operationId", "leaseToken"
         FROM farm.claim_feeding_job(
           $1::uuid, 'v2.meal-window.sweep', $3, $4::date,
           $5, 'tenant_site_catalog', 'site_local', 'site', $2::uuid,
           $6, $7, $8, $9::bigint, $10::bigint, $11, $12::jsonb
         )`,
      [
        TENANT_ID,
        SITE_ID,
        envelope.scheduleKey,
        envelope.localDate,
        envelope.timezone,
        FEEDING_JOB_CATALOG_REVISION,
        FEEDING_JOB_CATALOG_DIGEST,
        commandDigest,
        Number(cut.catalogAdmissionGeneration),
        Number(cut.authorityGeneration),
        cut.targetSetDigest,
        scheduledIntent(envelope, cut),
      ],
    );
    expect(claims).toHaveLength(1);
    const before: Array<{ catalogDigest: string; catalogDefinition: Record<string, unknown> }> =
      await runner().query(
        `SELECT "catalogDigest"::text AS "catalogDigest", "catalogDefinition"
           FROM farm.feeding_job_run_projection
          WHERE "operationId" = $1`,
        [claims[0]?.operationId],
      );

    await runner().startTransaction();
    await runner().query(
      `INSERT INTO farm.feeding_catalog_revisions (
         digest, revision, "canonicalJson", "jobCount"
       ) VALUES ($1, 'feeding-job-catalog/v2', $2, $3)`,
      [NEXT_DIGEST, NEXT_CANONICAL_JSON, NEXT_DEFINITIONS.length],
    );
    await runner().query(
      `INSERT INTO farm.feeding_job_catalog_entries (
         "catalogDigest", id, capability, "scheduleKind", "clockProfile",
         "targetCardinality", "timezoneSource",
         "leaseSeconds", enabled, definition
       )
       SELECT $1, id, capability, "scheduleKind", "clockProfile",
              "targetCardinality", "timezoneSource", "leaseSeconds", enabled, definition
         FROM jsonb_to_recordset($2::jsonb) AS d(
           id varchar, capability varchar, "scheduleKind" varchar, "clockProfile" varchar,
           "targetCardinality" varchar, "timezoneSource" varchar, "leaseSeconds" integer,
           enabled boolean, definition jsonb
         )`,
      [
        NEXT_DIGEST,
        JSON.stringify(NEXT_DEFINITIONS.map((definition) => ({ ...definition, definition }))),
      ],
    );
    const admission: Array<{ generation: string; activeDigest: string }> = await runner().query(
      `SELECT generation::text AS generation, "activeDigest"::text AS "activeDigest"
         FROM farm.feeding_catalog_admission WHERE authority = 'feeding'`,
    );
    await runner().query(`SELECT farm.admit_feeding_catalog($1, $2, $3, $4, $5::jsonb)`, [
      Number(admission[0]?.generation),
      admission[0]?.activeDigest,
      NEXT_DIGEST,
      'authority-test-next',
      admissionEvidence(
        'authority-test-next',
        'release-v2',
        Number(admission[0]?.generation) + 1,
        NEXT_DIGEST,
        'feeding-job-catalog/v2',
        NEXT_DEFINITIONS.length,
      ),
    ]);
    await activateFeedingWriterAuthority(runner(), TENANT_ID, {
      actor: 'authority-test-next',
      operationId: 'writer-v2',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();

    const after: Array<{ catalogDigest: string; catalogDefinition: Record<string, unknown> }> =
      await runner().query(
        `SELECT "catalogDigest"::text AS "catalogDigest", "catalogDefinition"
           FROM farm.feeding_job_run_projection
          WHERE "operationId" = $1`,
        [claims[0]?.operationId],
      );
    expect(after).toEqual(before);
    expect(after[0]?.catalogDigest).toBe(FEEDING_JOB_CATALOG_DIGEST);

    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'release-current-readmit',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();
    const artifacts: Array<{ roots: number; nextEntries: number }> = await runner().query(
      `SELECT
         (SELECT count(*)::int FROM farm.feeding_catalog_revisions) AS roots,
         (SELECT count(*)::int FROM farm.feeding_job_catalog_entries
           WHERE "catalogDigest" = $1) AS "nextEntries"`,
      [NEXT_DIGEST],
    );
    expect(artifacts).toEqual([{ roots: 2, nextEntries: NEXT_DEFINITIONS.length }]);
  });

  it('keeps tenant activation idempotent, fences reactivation, and denies raw runtime reads', async () => {
    const before: Array<{ generation: string; state: string }> = await runner().query(
      `SELECT generation::text AS generation, state
         FROM farm.feeding_writer_authority WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'release-idempotent',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();
    const replayed: Array<{ generation: string; state: string }> = await runner().query(
      `SELECT generation::text AS generation, state
         FROM farm.feeding_writer_authority WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    expect(replayed).toEqual(before);

    await runner().query(
      `UPDATE admin.tenant_schemas SET status = 'deleted' WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'tenant-delete',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();
    await runner().query(
      `UPDATE admin.tenant_schemas SET status = 'active' WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    await runner().startTransaction();
    await reconcileFeedingWriterAuthorities(runner(), {
      actor: 'authority-test',
      operationId: 'tenant-reactivate',
      reason: 'release_convergence',
    });
    await runner().commitTransaction();
    const reactivated: Array<{ generation: string }> = await runner().query(
      `SELECT generation::text AS generation
         FROM farm.feeding_writer_authority WHERE "tenantId" = $1`,
      [TENANT_ID],
    );
    expect(Number(reactivated[0]?.generation)).toBe(Number(before[0]?.generation) + 2);

    await runner().query(`SET ROLE farm_service`);
    try {
      await expect(runner().query(`SELECT * FROM farm.feeding_job_run_projection`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        runner().query(`INSERT INTO farm.feeding_job_runs (id) VALUES (gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        runner().query(
          `SELECT farm.admit_feeding_catalog(NULL, NULL, $1, 'runtime', '{}'::jsonb)`,
          [FEEDING_JOB_CATALOG_DIGEST],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        runner().query(
          `SELECT * FROM farm.compile_feeding_scheduler_cut($1, $2, clock_timestamp())`,
          [FEEDING_JOB_CATALOG_REVISION, FEEDING_JOB_CATALOG_DIGEST],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await runner().query(`RESET ROLE`);
    }

    await runner().query(`SET ROLE ${FEEDING_SCHEDULER_ROLE}`);
    try {
      await expect(runner().query(`SELECT * FROM farm.feeding_writer_authority`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        runner().query(
          `SELECT * FROM farm.claim_feeding_job(
             $1::uuid, 'v2.forecast.refresh', 'forbidden', current_date,
             'UTC', 'tenant_site_catalog', 'site_local', 'site', $2::uuid,
             $3, $4, $5, NULL, NULL, NULL, '{}'::jsonb
           )`,
          [
            TENANT_ID,
            SITE_ID,
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            'f'.repeat(64),
          ],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await runner().query(`RESET ROLE`);
    }

    await runner().query(`SET ROLE ${FEEDING_MIGRATION_ROLE}`);
    try {
      await expect(
        runner().query(
          `UPDATE farm.feeding_writer_authority SET generation = generation + 1
            WHERE "tenantId" = $1`,
          [TENANT_ID],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        runner().query(
          `INSERT INTO farm.feeding_writer_authority_history (
             "tenantId", generation, state, "catalogDigest", transition,
             "changedBy", evidence
           ) VALUES ($1, 999, 'active', $2, 'activated', 'forbidden', '{}'::jsonb)`,
          [TENANT_ID, FEEDING_JOB_CATALOG_DIGEST],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await runner().query(`RESET ROLE`);
    }
  });

  it('keeps the TypeScript and PostgreSQL lock-scope digest identical and rejects tampered intent', async () => {
    const coordinates = {
      tenantId: TENANT_ID,
      jobId: 'v2.forecast.refresh',
      targetKind: 'site',
      targetId: SITE_ID,
      localDate: '2026-08-05',
    } as const;
    const digestRows: Array<{ digest: string }> = await runner().query(
      `SELECT ${feedingOperationLockSetDigestSqlV1({
        tenantIdTextSql: '$1::uuid::text',
        jobIdTextSql: '$2::text',
        targetKindTextSql: '$3::text',
        targetIdTextSql: '$4::uuid::text',
        localDateTextSql: '$5::date::text',
      })} AS digest`,
      [
        coordinates.tenantId,
        coordinates.jobId,
        coordinates.targetKind,
        coordinates.targetId,
        coordinates.localDate,
      ],
    );
    expect(digestRows).toEqual([{ digest: compileFeedingOperationLockSetDigestV1(coordinates) }]);

    const requestId = 'forecast-lock-set-tamper';
    const commandDigest = manualCommandDigest(requestId, SITE_ID);
    const commandPayload = manualCommandPayload(requestId, SITE_ID);
    const commandDigestRows: Array<{ digest: string }> = await runner().query(
      `SELECT ${feedingOperationCommandDigestSqlV1('$1::jsonb')} AS digest`,
      [strictJson(commandPayload)],
    );
    expect(commandDigestRows).toEqual([{ digest: commandDigest }]);
    const validIntent = JSON.parse(
      manualIntent({
        requestId,
        targetId: SITE_ID,
        commandDigest,
        observedAt: '2026-08-05T04:00:30.000Z',
        dueAt: '2026-08-05T04:00:00.000Z',
        localDate: '2026-08-05',
        timezone: 'Europe/Oslo',
      }),
    ) as Record<string, unknown>;
    const claim = (
      intent: Record<string, unknown>,
      scheduleKey = requestId,
      presentedCommandDigest = commandDigest,
    ): Promise<unknown[]> =>
      runner().query(
        `SELECT * FROM farm.claim_feeding_job(
           $1::uuid, 'v2.forecast.refresh', $2, '2026-08-05'::date,
           'Europe/Oslo', 'tenant_site_catalog', 'site_local', 'site', $3::uuid,
           $4, $5, $6, NULL, NULL, NULL, $7::jsonb
         )`,
        [
          TENANT_ID,
          scheduleKey,
          SITE_ID,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_DIGEST,
          presentedCommandDigest,
          strictJson(intent),
        ],
      );

    await runner().query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT_ID]);
    await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
    try {
      await expect(claim({ ...validIntent, lockSetDigest: '0'.repeat(64) })).rejects.toThrow(
        /closed identity contract/i,
      );
      await expect(
        claim({
          ...validIntent,
          commandPayload: { ...commandPayload, emitCoverageEvents: true },
        }),
      ).rejects.toThrow(/closed identity contract/i);
      const foreignJobPayload = { ...commandPayload, jobId: 'manual.meal.skip' } as const;
      await expect(
        claim(
          {
            ...validIntent,
            commandDigest: feedingOperationCommandDigestV1(foreignJobPayload),
            commandPayload: foreignJobPayload,
          },
          requestId,
          feedingOperationCommandDigestV1(foreignJobPayload),
        ),
      ).rejects.toThrow(/closed identity contract/i);
      const foreignTenantPayload = {
        ...commandPayload,
        tenantId: '33333333-3333-4333-8333-333333333333',
      } as const;
      await expect(
        claim(
          {
            ...validIntent,
            commandDigest: feedingOperationCommandDigestV1(foreignTenantPayload),
            commandPayload: foreignTenantPayload,
          },
          requestId,
          feedingOperationCommandDigestV1(foreignTenantPayload),
        ),
      ).rejects.toThrow(/closed identity contract/i);
      const splitRequestPayload = { ...commandPayload, requestId: 'split-request' } as const;
      await expect(
        claim(
          {
            ...validIntent,
            commandDigest: feedingOperationCommandDigestV1(splitRequestPayload),
            commandPayload: splitRequestPayload,
          },
          requestId,
          feedingOperationCommandDigestV1(splitRequestPayload),
        ),
      ).rejects.toThrow(/closed identity contract|scope or evidence disagrees/i);
      const foreignTargetPayload = {
        ...commandPayload,
        siteId: '33333333-3333-4333-8333-333333333333',
      } as const;
      await expect(
        claim(
          {
            ...validIntent,
            commandDigest: feedingOperationCommandDigestV1(foreignTargetPayload),
            commandPayload: foreignTargetPayload,
          },
          requestId,
          feedingOperationCommandDigestV1(foreignTargetPayload),
        ),
      ).rejects.toThrow(/direct target authority/i);
      await expect(
        claim({ ...validIntent, observedAt: '2026-08-05T04:00:30+00:00' }),
      ).rejects.toThrow(/closed identity contract/i);
      await expect(
        claim({ ...validIntent, scheduleKey: 'second-idempotency-key' }, 'second-idempotency-key'),
      ).rejects.toThrow(/scope or evidence disagrees/i);
      await expect(claim({ ...validIntent, dueAt: '2026-08-05T04:00:01.000Z' })).rejects.toThrow(
        /scope or evidence disagrees/i,
      );
      await expect(claim({ ...validIntent, caughtUp: true })).rejects.toThrow(
        /scope or evidence disagrees/i,
      );
      await expect(claim({ ...validIntent, dstGapAdjusted: true })).rejects.toThrow(
        /scope or evidence disagrees/i,
      );
    } finally {
      await runner().query(`RESET ROLE`);
    }
  });

  it('reclaims an expired lease with the original pinned envelope despite process-clock drift', async () => {
    const requestId = 'forecast-expired-lease-reclaim';
    const commandDigest = manualCommandDigest(requestId, SITE_ID);
    const originalIntent = {
      requestId,
      targetId: SITE_ID,
      commandDigest,
      observedAt: '2026-08-05T22:00:30.000Z',
      dueAt: '2026-08-05T22:00:00.000Z',
      localDate: '2026-08-06',
      timezone: 'Europe/Oslo',
    } as const;
    const driftedIntent = {
      ...originalIntent,
      observedAt: '2026-08-07T04:00:30.000Z',
      dueAt: '2026-08-07T04:00:00.000Z',
      localDate: '2026-08-07',
      timezone: 'UTC',
    } as const;
    type PinnedClaim = {
      disposition: string;
      operationId: string;
      leaseToken: string;
      generation: string;
      attempt: number;
      leaseExpiresAt: Date;
      intent: unknown;
    };
    const claimSql = `SELECT disposition, "operationId", "leaseToken",
                             generation::text AS generation, attempt,
                             "leaseExpiresAt", intent
                        FROM farm.claim_feeding_job(
                          $1::uuid, 'v2.forecast.refresh', $2, $3::date,
                          $4, 'tenant_site_catalog', 'site_local', 'site', $5::uuid,
                          $6, $7, $8, NULL, NULL, NULL, $9::jsonb
                        )`;
    const claimParameters = (intent: ManualIntentCoordinatesV1): unknown[] => [
      TENANT_ID,
      requestId,
      intent.localDate,
      intent.timezone,
      intent.targetId,
      FEEDING_JOB_CATALOG_REVISION,
      FEEDING_JOB_CATALOG_DIGEST,
      intent.commandDigest,
      manualIntent(intent),
    ];

    await runner().query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT_ID]);
    await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
    let first: PinnedClaim | undefined;
    try {
      const rows: PinnedClaim[] = await runner().query(claimSql, claimParameters(originalIntent));
      first = rows[0];
    } finally {
      await runner().query(`RESET ROLE`);
    }
    if (!first) throw new Error('Initial reclaim fixture claim returned no row');
    const firstIntent = decodeFeedingOperationIntentV1(first.intent);
    const firstPersistedCommand = decodeFeedingOperationCommandFromIntentV1(
      'v2.forecast.refresh',
      firstIntent,
    );
    expect(first).toMatchObject({
      disposition: 'execute',
      attempt: 1,
    });
    expect(firstIntent).toMatchObject(originalIntent);
    expect(firstPersistedCommand).toMatchObject({
      jobId: 'v2.forecast.refresh',
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      requestId,
      emitCoverageEvents: false,
    });
    expect(Object.isFrozen(firstPersistedCommand)).toBe(true);

    await runner().query(
      `UPDATE farm.feeding_job_runs
          SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "operationId" = $1`,
      [first.operationId],
    );

    const conflictingTargetIntent = {
      ...originalIntent,
      targetId: '33333333-3333-4333-8333-333333333333',
      commandDigest: manualCommandDigest(requestId, '33333333-3333-4333-8333-333333333333'),
    } as const;
    await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
    try {
      await expect(
        runner().query(claimSql, claimParameters(conflictingTargetIntent)),
      ).rejects.toThrow(/immutable command digest/i);
    } finally {
      await runner().query(`RESET ROLE`);
    }
    const afterRejectedTarget: Array<{
      attempt: number;
      leaseToken: string;
      intent: unknown;
    }> = await runner().query(
      `SELECT attempt, "leaseToken", evidence->'intent' AS intent
         FROM farm.feeding_job_runs
        WHERE "operationId" = $1`,
      [first.operationId],
    );
    expect(afterRejectedTarget).toHaveLength(1);
    expect(afterRejectedTarget[0]).toMatchObject({
      attempt: 1,
      leaseToken: first.leaseToken,
    });
    expect(decodeFeedingOperationIntentV1(afterRejectedTarget[0]?.intent)).toEqual(firstIntent);

    await runner().query(`SET ROLE ${FEEDING_RUNTIME_ROLE}`);
    try {
      const reclaimedRows: PinnedClaim[] = await runner().query(
        claimSql,
        claimParameters(driftedIntent),
      );
      const reclaimed = reclaimedRows[0];
      if (!reclaimed) throw new Error('Expired feeding lease was not reclaimed');
      const reclaimedIntent = decodeFeedingOperationIntentV1(reclaimed.intent);
      const reclaimedCommand = decodeFeedingOperationCommandFromIntentV1(
        'v2.forecast.refresh',
        reclaimedIntent,
      );
      expect(reclaimed).toMatchObject({
        disposition: 'execute',
        operationId: first.operationId,
        generation: first.generation,
        attempt: 2,
      });
      expect(reclaimedIntent).toEqual(firstIntent);
      expect(reclaimedCommand).toEqual(firstPersistedCommand);
      expect(reclaimedCommand).not.toBe(firstPersistedCommand);

      const resultSchema = 'feeding-operation-result/v2.forecast.refresh/v1';
      const resultArtifact = compileFeedingResultArtifactV1(resultSchema, {
        refreshedCount: 1,
      });
      const operationEnvelopeDigest = compileFeedingOperationEnvelopeV1({
        observedAt: reclaimedIntent.observedAt,
        catalogDigest: reclaimedIntent.catalogDigest,
        commandDigest: reclaimedIntent.commandDigest,
        authorityGeneration: Number(reclaimed.generation),
        lockSetDigest: reclaimedIntent.lockSetDigest,
      }).digest;
      const completion: Array<{ accepted: boolean }> = await runner().query(
        `SELECT farm.complete_feeding_job(
           $1::uuid, $2::uuid, $3, $4, $5, $6::text, $7, $8::jsonb
         ) AS accepted`,
        [
          reclaimed.operationId,
          reclaimed.leaseToken,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_DIGEST,
          resultSchema,
          resultArtifact.payloadJson,
          resultArtifact.digest,
          strictJson({
            schemaVersion: 'feeding-operation-result/v1',
            operationId: reclaimed.operationId,
            jobId: 'v2.forecast.refresh',
            generation: Number(reclaimed.generation),
            outcome: 'succeeded',
            catalogRevision: FEEDING_JOB_CATALOG_REVISION,
            catalogDigest: reclaimedIntent.catalogDigest,
            resultSchema,
            resultDigest: resultArtifact.digest,
            operationEnvelopeDigest,
          }),
        ],
      );
      expect(completion).toEqual([{ accepted: true }]);
    } finally {
      await runner().query(`RESET ROLE`);
    }

    const persisted: Array<{
      observedAt: Date;
      localDate: string;
      intent: Record<string, unknown>;
    }> = await runner().query(
      `SELECT "observedAt", "localDate"::text AS "localDate", evidence->'intent' AS intent
           FROM farm.feeding_job_runs
          WHERE "operationId" = $1`,
      [first.operationId],
    );
    expect(persisted[0]).toMatchObject({
      observedAt: new Date(originalIntent.observedAt),
      localDate: originalIntent.localDate,
      intent: {
        observedAt: originalIntent.observedAt,
        localDate: originalIntent.localDate,
        timezone: originalIntent.timezone,
        lockSetDigest: firstIntent.lockSetDigest,
      },
    });
  });

  it('uses request identity for exact replay and rejects it after a writer epoch change', async () => {
    const requestId = 'forecast-request-1';
    const commandDigest = manualCommandDigest(requestId, SITE_ID);
    await runner().query(`SELECT set_config('app.current_tenant', $1, false)`, [TENANT_ID]);
    await runner().query(`SET ROLE farm_service`);
    let claimed:
      | {
          disposition: string;
          operationId: string;
          leaseToken: string;
          generation: string;
          intent: unknown;
        }
      | undefined;
    try {
      const rows: Array<{
        disposition: string;
        operationId: string;
        leaseToken: string;
        generation: string;
        intent: unknown;
      }> = await runner().query(
        `SELECT disposition, "operationId", "leaseToken", generation::text AS generation,
                intent
           FROM farm.claim_feeding_job(
             $1::uuid, 'v2.forecast.refresh', $2, '2026-08-05'::date,
             'Europe/Oslo', 'tenant_site_catalog', 'site_local', 'site', $3::uuid,
             $4, $5, $6, NULL, NULL, NULL, $7::jsonb
           )`,
        [
          TENANT_ID,
          requestId,
          SITE_ID,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_DIGEST,
          commandDigest,
          manualIntent({
            requestId,
            targetId: SITE_ID,
            commandDigest,
            observedAt: '2026-08-05T04:00:30.000Z',
            dueAt: '2026-08-05T04:00:00.000Z',
            localDate: '2026-08-05',
            timezone: 'Europe/Oslo',
          }),
        ],
      );
      claimed = rows[0];
      expect(claimed?.disposition).toBe('execute');
      if (!claimed) throw new Error('on-demand feeding claim returned no row');
      const claimedIntent = decodeFeedingOperationIntentV1(claimed.intent);
      const resultSchema = 'feeding-operation-result/v2.forecast.refresh/v1';
      const resultValue = { refreshedCount: 3 };
      const resultArtifact = compileFeedingResultArtifactV1(resultSchema, resultValue);
      const resultPayload = resultArtifact.payloadJson;
      const resultDigest = resultArtifact.digest;
      const operationEnvelopeDigest = compileFeedingOperationEnvelopeV1({
        observedAt: claimedIntent.observedAt,
        catalogDigest: claimedIntent.catalogDigest,
        commandDigest: claimedIntent.commandDigest,
        authorityGeneration: Number(claimed.generation),
        lockSetDigest: claimedIntent.lockSetDigest,
      }).digest;
      const successEvidence = strictJson({
        schemaVersion: 'feeding-operation-result/v1',
        operationId: claimed.operationId,
        jobId: 'v2.forecast.refresh',
        generation: Number(claimed.generation),
        outcome: 'succeeded',
        catalogRevision: FEEDING_JOB_CATALOG_REVISION,
        catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
        resultSchema,
        resultDigest,
        operationEnvelopeDigest,
      });

      for (const nonCanonicalPayload of ['{"refreshedCount": 3}', '{\n  "refreshedCount":3\n}']) {
        await expect(
          runner().query(
            `SELECT farm.complete_feeding_job(
               $1::uuid, $2::uuid, $3, $4, $5, $6::text, $7, $8::jsonb
             )`,
            [
              claimed.operationId,
              claimed.leaseToken,
              FEEDING_JOB_CATALOG_REVISION,
              FEEDING_JOB_CATALOG_DIGEST,
              resultSchema,
              nonCanonicalPayload,
              resultDigest,
              successEvidence,
            ],
          ),
        ).rejects.toThrow(/closed identity contract/i);
      }
      const reorderedArtifact = compileFeedingResultArtifactV1(resultSchema, {
        refreshedCount: 3,
        z: 2,
      });
      await expect(
        runner().query(
          `SELECT farm.complete_feeding_job(
             $1::uuid, $2::uuid, $3, $4, $5, $6::text, $7, $8::jsonb
           )`,
          [
            claimed.operationId,
            claimed.leaseToken,
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            resultSchema,
            '{"z":2,"refreshedCount":3}',
            reorderedArtifact.digest,
            strictJson({
              schemaVersion: 'feeding-operation-result/v1',
              operationId: claimed.operationId,
              jobId: 'v2.forecast.refresh',
              generation: Number(claimed.generation),
              outcome: 'succeeded',
              catalogRevision: FEEDING_JOB_CATALOG_REVISION,
              catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
              resultSchema,
              resultDigest: reorderedArtifact.digest,
              operationEnvelopeDigest,
            }),
          ],
        ),
      ).rejects.toThrow(/closed identity contract/i);

      const wrongDigest = '0'.repeat(64);
      await expect(
        runner().query(
          `SELECT farm.complete_feeding_job(
             $1::uuid, $2::uuid, $3, $4, $5, $6::text, $7, $8::jsonb
           )`,
          [
            claimed.operationId,
            claimed.leaseToken,
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            resultSchema,
            resultPayload,
            wrongDigest,
            strictJson({
              schemaVersion: 'feeding-operation-result/v1',
              operationId: claimed.operationId,
              jobId: 'v2.forecast.refresh',
              generation: Number(claimed.generation),
              outcome: 'succeeded',
              catalogRevision: FEEDING_JOB_CATALOG_REVISION,
              catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
              resultSchema,
              resultDigest: wrongDigest,
              operationEnvelopeDigest,
            }),
          ],
        ),
      ).rejects.toThrow(/closed identity contract/i);

      const completed: Array<{ accepted: boolean }> = await runner().query(
        `SELECT farm.complete_feeding_job(
           $1::uuid, $2::uuid, $3, $4, $5, $6::text, $7, $8::jsonb
         ) AS accepted`,
        [
          claimed.operationId,
          claimed.leaseToken,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_DIGEST,
          resultSchema,
          resultPayload,
          resultDigest,
          successEvidence,
        ],
      );
      expect(completed).toEqual([{ accepted: true }]);

      await expect(
        runner().query(
          `SELECT * FROM farm.claim_feeding_job(
             $1::uuid, 'v2.forecast.refresh', $2, '2026-08-05'::date,
             'Europe/Oslo', 'tenant_site_catalog', 'site_local', 'site', $3::uuid,
             $4, $5, $6, NULL, NULL, NULL, $7::jsonb
           )`,
          [
            TENANT_ID,
            requestId,
            '33333333-3333-4333-8333-333333333333',
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            manualCommandDigest(requestId, '33333333-3333-4333-8333-333333333333'),
            manualIntent({
              requestId,
              targetId: '33333333-3333-4333-8333-333333333333',
              commandDigest: manualCommandDigest(requestId, '33333333-3333-4333-8333-333333333333'),
              observedAt: '2026-08-05T04:00:30.000Z',
              dueAt: '2026-08-05T04:00:00.000Z',
              localDate: '2026-08-05',
              timezone: 'Europe/Oslo',
            }),
          ],
        ),
      ).rejects.toThrow(/immutable command digest/i);

      const replayed: Array<{
        disposition: string;
        operationId: string;
        resultSchema: string;
        resultPayload: string;
        resultDigest: string;
      }> = await runner().query(
        `SELECT disposition, "operationId", "resultSchema", "resultPayload", "resultDigest"
           FROM farm.claim_feeding_job(
             $1::uuid, 'v2.forecast.refresh', $2, '2026-08-05'::date,
             'Europe/Oslo', 'tenant_site_catalog', 'site_local', 'site', $3::uuid,
             $4, $5, $6, NULL, NULL, NULL, $7::jsonb
           )`,
        [
          TENANT_ID,
          requestId,
          SITE_ID,
          FEEDING_JOB_CATALOG_REVISION,
          FEEDING_JOB_CATALOG_DIGEST,
          commandDigest,
          manualIntent({
            requestId,
            targetId: SITE_ID,
            commandDigest,
            observedAt: '2026-08-05T04:00:30.000Z',
            dueAt: '2026-08-05T04:00:00.000Z',
            localDate: '2026-08-05',
            timezone: 'Europe/Oslo',
          }),
        ],
      );
      expect(replayed).toEqual([
        {
          disposition: 'replay',
          operationId: claimed.operationId,
          resultSchema: 'feeding-operation-result/v2.forecast.refresh/v1',
          resultPayload: '{"refreshedCount":3}',
          resultDigest: compileFeedingResultArtifactV1(
            'feeding-operation-result/v2.forecast.refresh/v1',
            { refreshedCount: 3 },
          ).digest,
        },
      ]);
    } finally {
      await runner().query(`RESET ROLE`);
    }

    await runner().startTransaction();
    await revokeFeedingWriterAuthority(runner(), TENANT_ID, {
      actor: 'epoch-test',
      operationId: 'writer-revoke',
      reason: 'tenant_reconcile',
    });
    await activateFeedingWriterAuthority(runner(), TENANT_ID, {
      actor: 'epoch-test',
      operationId: 'writer-reactivate',
      reason: 'tenant_reconcile',
    });
    await runner().commitTransaction();
    await runner().query(`SET ROLE farm_service`);
    try {
      await expect(
        runner().query(
          `SELECT * FROM farm.claim_feeding_job(
             $1::uuid, 'v2.forecast.refresh', $2, '2026-08-05'::date,
             'Europe/Oslo', 'tenant_site_catalog', 'site_local', 'site', $3::uuid,
             $4, $5, $6, NULL, NULL, NULL, $7::jsonb
           )`,
          [
            TENANT_ID,
            requestId,
            SITE_ID,
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            commandDigest,
            manualIntent({
              requestId,
              targetId: SITE_ID,
              commandDigest,
              observedAt: '2026-08-05T04:00:30.000Z',
              dueAt: '2026-08-05T04:00:00.000Z',
              localDate: '2026-08-05',
              timezone: 'Europe/Oslo',
            }),
          ],
        ),
      ).rejects.toThrow(/stale catalog or writer epoch/i);
    } finally {
      await runner().query(`RESET ROLE`);
    }
    const counts: Array<{ count: number }> = await runner().query(
      `SELECT count(*)::int AS count
         FROM farm.feeding_job_runs
        WHERE "tenantId" = $1 AND "catalogJob" = 'v2.forecast.refresh' AND "scheduleKey" = $2`,
      [TENANT_ID, requestId],
    );
    expect(counts).toEqual([{ count: 1 }]);
  });
});
