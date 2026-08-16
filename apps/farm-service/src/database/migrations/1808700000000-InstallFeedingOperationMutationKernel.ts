import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
  bindFeedingMigrationExecutionScopeV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
const FEEDING_RESULT_PORTABILITY_V1 = FEEDING_MIGRATION_AUTHORITY_V1.resultArtifact.portability;
const FEEDING_CONTROL_PLANE_KERNEL_FUNCTIONS =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.kernelFunctions;
const FEEDING_CONTROL_PLANE_RELATIONS = FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.relations;
const FEEDING_DATABASE_OWNER_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.databaseOwner;
const FEEDING_MIGRATION_KERNEL_FUNCTIONS =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.migrationFunctions;
const FEEDING_MIGRATION_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.migration;
const FEEDING_MIGRATION_RELATION_PRIVILEGES =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.migrationRelationPrivileges;
const FEEDING_RUNTIME_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.runtime;
const FEEDING_SCHEDULER_KERNEL_FUNCTIONS =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.schedulerFunctions;
const FEEDING_SCHEDULER_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.scheduler;
const FEEDING_TENANT_RUNTIME_KERNEL_FUNCTIONS =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.tenantRuntimeFunctions;

function operationEnvelopeDigestSql(runAlias: 'r'): string {
  return `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    farm.canonical_feeding_json(pg_catalog.jsonb_build_object(
      'domain', 'aquaculture.feeding-operation-envelope',
      'schemaVersion', 'feeding-operation-envelope/v1',
      'value', pg_catalog.jsonb_build_object(
        'schemaVersion', 'feeding-operation-envelope/v1',
        'observedAt', ${runAlias}.evidence->'intent'->>'observedAt',
        'catalogDigest', ${runAlias}.evidence->'intent'->>'catalogDigest',
        'commandDigest', ${runAlias}.evidence->'intent'->>'commandDigest',
        'authorityGeneration', ${runAlias}.generation,
        'lockSetDigest', ${runAlias}.evidence->'intent'->>'lockSetDigest'
      )
    )), 'UTF8'
  )), 'hex')`;
}

interface FeedingOperationLockSetSqlCoordinatesV1 {
  readonly tenantIdTextSql: string;
  readonly jobIdTextSql: string;
  readonly targetKindTextSql: string;
  readonly targetIdTextSql: string;
  readonly localDateTextSql: string;
}

/** SQL half of the versioned lock-scope digest; also consumed by the PG golden-vector test. */
export function feedingOperationLockSetDigestSqlV1(
  coordinates: FeedingOperationLockSetSqlCoordinatesV1,
): string {
  return `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    farm.canonical_feeding_json(pg_catalog.jsonb_build_object(
      'domain', 'aquaculture.feeding-operation-lock-set',
      'schemaVersion', 'feeding-operation-lock-set/v1',
      'value', pg_catalog.jsonb_build_object(
        'tenantId', ${coordinates.tenantIdTextSql},
        'jobId', ${coordinates.jobIdTextSql},
        'targetKind', ${coordinates.targetKindTextSql},
        'targetId', ${coordinates.targetIdTextSql},
        'localDate', ${coordinates.localDateTextSql}
      )
    )), 'UTF8'
  )), 'hex')`;
}

/** SQL half of the versioned persisted-command digest; consumed by claim validation and PG vectors. */
export function feedingOperationCommandDigestSqlV1(commandPayloadSql: string): string {
  return `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    farm.canonical_feeding_json(pg_catalog.jsonb_build_object(
      'domain', 'aquaculture.feeding-operation-command',
      'schemaVersion', 'feeding-operation-command/v1',
      'value', ${commandPayloadSql}
    )), 'UTF8'
  )), 'hex')`;
}

/** Installs the database-owned feeding mutation kernel and least-privilege ACL. */
export class InstallFeedingOperationMutationKernel1808700000000 implements MigrationInterface {
  name = 'InstallFeedingOperationMutationKernel1808700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.admit_feeding_catalog(
        p_expected_generation bigint,
        p_expected_digest varchar,
        p_new_digest varchar,
        p_actor varchar,
        p_evidence jsonb
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_root farm.feeding_catalog_revisions%ROWTYPE;
        v_current farm.feeding_catalog_admission%ROWTYPE;
        v_canonical_count integer;
        v_distinct_count integer;
        v_entry_count integer;
        v_invalid_jobs text;
        v_next_generation bigint;
        v_updated integer;
      BEGIN
        IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
          RAISE EXCEPTION 'feeding admission evidence must be a JSON object'
            USING ERRCODE = '22023';
        END IF;
        IF NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'actor', 'operationId', 'reason', 'catalogRevision', 'catalogDigest',
               'catalogJobCount', 'admissionGeneration'
             ]
           )
           OR p_evidence->>'actor' IS DISTINCT FROM p_actor
           OR pg_catalog.length(p_evidence->>'operationId') NOT BETWEEN 1 AND 160
           OR p_evidence->>'reason' NOT IN (
             'release_convergence', 'tenant_provision', 'tenant_reconcile', 'tenant_delete'
           ) THEN
          RAISE EXCEPTION 'feeding admission evidence violates its closed identity contract'
            USING ERRCODE = '22023';
        END IF;
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(p_new_digest::text, 0)
        );
        SELECT * INTO STRICT v_root
          FROM farm.feeding_catalog_revisions root
         WHERE root.digest = p_new_digest
         FOR SHARE;

        IF NOT farm.jsonb_has_exact_keys(
             v_root."canonicalJson"::jsonb,
             ARRAY['revision','dispatchRetryPolicy','scheduleExecutionPolicy','jobs']
           )
           OR v_root.revision !~ '^feeding-job-catalog/v[1-9][0-9]{0,8}$'
           OR pg_catalog.length(v_root.revision) NOT BETWEEN 22 AND 80
           OR v_root."canonicalJson" IS DISTINCT FROM
             farm.canonical_feeding_json(v_root."canonicalJson"::jsonb) THEN
          RAISE EXCEPTION 'feeding catalog root % violates canonical root contract', p_new_digest
            USING ERRCODE = '23514';
        END IF;

        SELECT count(*)::integer, count(DISTINCT job.value->>'id')::integer
          INTO v_canonical_count, v_distinct_count
          FROM pg_catalog.jsonb_array_elements(
            v_root."canonicalJson"::jsonb->'jobs'
          ) AS job(value);
        SELECT count(*)::integer INTO v_entry_count
          FROM farm.feeding_job_catalog_entries entry
         WHERE entry."catalogDigest" = v_root.digest;
        SELECT pg_catalog.string_agg(job.value->>'id', ',' ORDER BY job.value->>'id')
          INTO v_invalid_jobs
          FROM pg_catalog.jsonb_array_elements(
            v_root."canonicalJson"::jsonb->'jobs'
          ) AS job(value)
         WHERE NOT farm.is_valid_feeding_catalog_job(job.value);

        IF v_canonical_count <> v_root."jobCount"
           OR v_distinct_count <> v_root."jobCount"
           OR v_invalid_jobs IS NOT NULL THEN
          RAISE EXCEPTION 'feeding catalog artifact % violates closed job semantics: %',
            p_new_digest, COALESCE(v_invalid_jobs, 'job-count')
            USING ERRCODE = '23514';
        END IF;
        IF v_entry_count <> v_root."jobCount"
           OR EXISTS (
             SELECT 1
               FROM pg_catalog.jsonb_array_elements(
                 v_root."canonicalJson"::jsonb->'jobs'
               ) AS job(value)
              WHERE NOT EXISTS (
                SELECT 1 FROM farm.feeding_job_catalog_entries entry
                 WHERE entry."catalogDigest" = v_root.digest
                   AND entry.id = job.value->>'id'
                   AND entry.definition = job.value
              )
           ) THEN
          RAISE EXCEPTION 'feeding catalog artifact % is not an exact canonical set', p_new_digest
            USING ERRCODE = '23514';
        END IF;
        IF p_evidence->>'catalogRevision' IS DISTINCT FROM v_root.revision
           OR p_evidence->>'catalogDigest' IS DISTINCT FROM v_root.digest::text
           OR pg_catalog.jsonb_typeof(p_evidence->'catalogJobCount') <> 'number'
           OR (p_evidence->>'catalogJobCount')::integer <> v_root."jobCount"
           OR pg_catalog.jsonb_typeof(p_evidence->'admissionGeneration') <> 'number' THEN
          RAISE EXCEPTION 'feeding admission evidence does not bind the catalog root'
            USING ERRCODE = '22023';
        END IF;

        SELECT * INTO v_current
          FROM farm.feeding_catalog_admission admission
         WHERE admission.authority = 'feeding'
         FOR UPDATE;
        IF NOT FOUND THEN
          IF p_expected_generation IS NOT NULL OR p_expected_digest IS NOT NULL THEN
            RAISE EXCEPTION 'feeding catalog admission CAS expected an existing pointer'
              USING ERRCODE = '40001';
          END IF;
          v_next_generation := 1;
          IF (p_evidence->>'admissionGeneration')::bigint <> v_next_generation THEN
            RAISE EXCEPTION 'feeding admission evidence generation mismatch'
              USING ERRCODE = '22023';
          END IF;
          INSERT INTO farm.feeding_catalog_admission (
            authority, generation, "activeDigest", "admittedBy", evidence
          ) VALUES ('feeding', v_next_generation, v_root.digest, p_actor, p_evidence);
          INSERT INTO farm.feeding_catalog_admission_history (
            generation, "catalogDigest", "admittedBy", evidence
          ) VALUES (v_next_generation, v_root.digest, p_actor, p_evidence);
          RETURN v_next_generation;
        END IF;

        IF v_current."activeDigest" = v_root.digest THEN
          v_next_generation := v_current.generation;
          IF (p_evidence->>'admissionGeneration')::bigint <> v_next_generation THEN
            RAISE EXCEPTION 'feeding admission evidence generation mismatch'
              USING ERRCODE = '22023';
          END IF;
          RETURN v_next_generation;
        END IF;
        IF p_expected_generation IS DISTINCT FROM v_current.generation
           OR p_expected_digest IS DISTINCT FROM v_current."activeDigest" THEN
          RAISE EXCEPTION 'feeding catalog admission CAS was lost'
            USING ERRCODE = '40001';
        END IF;

        v_next_generation := v_current.generation + 1;
        IF (p_evidence->>'admissionGeneration')::bigint <> v_next_generation THEN
          RAISE EXCEPTION 'feeding admission evidence generation mismatch'
            USING ERRCODE = '22023';
        END IF;
        UPDATE farm.feeding_catalog_admission admission
           SET generation = v_next_generation,
               "activeDigest" = v_root.digest,
               "admittedBy" = p_actor,
               evidence = p_evidence,
               "admittedAt" = pg_catalog.clock_timestamp()
         WHERE admission.authority = 'feeding'
           AND admission.generation = p_expected_generation
           AND admission."activeDigest" = p_expected_digest;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> 1 THEN
          RAISE EXCEPTION 'feeding catalog admission CAS was lost'
            USING ERRCODE = '40001';
        END IF;
        INSERT INTO farm.feeding_catalog_admission_history (
          generation, "catalogDigest", "admittedBy", evidence
        ) VALUES (v_next_generation, v_root.digest, p_actor, p_evidence);
        RETURN v_next_generation;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding catalog root % is missing', p_new_digest
            USING ERRCODE = '23503';
      END;
      $body$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb) FROM PUBLIC`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.transition_feeding_writer_authority(
        p_tenant_id uuid,
        p_expected_generation bigint,
        p_expected_state varchar,
        p_expected_catalog_digest varchar,
        p_target_catalog_digest varchar,
        p_target_state varchar,
        p_actor varchar,
        p_evidence jsonb
      )
      RETURNS TABLE (
        "tenantId" uuid,
        generation bigint,
        state varchar,
        "catalogDigest" varchar,
        "changedBy" varchar,
        evidence jsonb,
        "transitionedAt" timestamptz,
        mutated boolean
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_current farm.feeding_writer_authority%ROWTYPE;
        v_result farm.feeding_writer_authority%ROWTYPE;
        v_admission farm.feeding_catalog_admission%ROWTYPE;
        v_root farm.feeding_catalog_revisions%ROWTYPE;
        v_next_generation bigint;
        v_transition varchar;
        v_mutated boolean;
        v_updated integer;
      BEGIN
        IF p_tenant_id IS NULL
           OR p_target_state NOT IN ('active', 'revoked')
           OR pg_catalog.length(p_actor) NOT BETWEEN 1 AND 160
           OR p_target_catalog_digest !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'feeding writer transition has invalid identity fields'
            USING ERRCODE = '22023';
        END IF;
        IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
          RAISE EXCEPTION 'feeding writer transition evidence must be a JSON object'
            USING ERRCODE = '22023';
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(p_tenant_id::text, 0)
        );
        SELECT admission.* INTO STRICT v_admission
          FROM farm.feeding_catalog_admission admission
         WHERE admission.authority = 'feeding'
           AND admission."activeDigest" = p_target_catalog_digest
         FOR SHARE;
        SELECT root.* INTO STRICT v_root
          FROM farm.feeding_catalog_revisions root
         WHERE root.digest = v_admission."activeDigest"
         FOR SHARE;

        SELECT authority.* INTO v_current
          FROM farm.feeding_writer_authority authority
         WHERE authority."tenantId" = p_tenant_id
         FOR UPDATE;
        IF NOT FOUND THEN
          IF p_expected_generation IS NOT NULL
             OR p_expected_state IS NOT NULL
             OR p_expected_catalog_digest IS NOT NULL
             OR p_target_state <> 'active' THEN
            RAISE EXCEPTION 'feeding writer transition CAS expected no existing authority'
              USING ERRCODE = '40001';
          END IF;
          v_next_generation := 1;
          v_mutated := true;
        ELSE
          IF p_expected_generation IS DISTINCT FROM v_current.generation
             OR p_expected_state IS DISTINCT FROM v_current.state
             OR p_expected_catalog_digest IS DISTINCT FROM v_current."catalogDigest" THEN
            RAISE EXCEPTION 'feeding writer transition CAS was lost'
              USING ERRCODE = '40001';
          END IF;
          IF v_current.state = p_target_state
             AND v_current."catalogDigest" = p_target_catalog_digest THEN
            v_next_generation := v_current.generation;
            v_mutated := false;
          ELSE
            v_next_generation := v_current.generation + 1;
            v_mutated := true;
          END IF;
        END IF;
        v_transition := CASE WHEN p_target_state = 'active' THEN 'activated' ELSE 'revoked' END;

        IF NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'actor', 'operationId', 'reason', 'catalogRevision', 'catalogDigest',
               'catalogJobCount', 'admissionGeneration', 'expectedWriterGeneration',
               'expectedWriterState', 'expectedWriterCatalogDigest', 'writerGeneration',
               'writerState', 'writerTransition'
             ]
           )
           OR p_evidence->>'actor' IS DISTINCT FROM p_actor
           OR pg_catalog.length(p_evidence->>'operationId') NOT BETWEEN 1 AND 160
           OR p_evidence->>'reason' NOT IN (
             'release_convergence', 'tenant_provision', 'tenant_reconcile', 'tenant_delete'
           )
           OR p_evidence->>'catalogRevision' IS DISTINCT FROM v_root.revision
           OR p_evidence->>'catalogDigest' IS DISTINCT FROM v_root.digest::text
           OR pg_catalog.jsonb_typeof(p_evidence->'catalogJobCount') <> 'number'
           OR (p_evidence->>'catalogJobCount')::integer <> v_root."jobCount"
           OR pg_catalog.jsonb_typeof(p_evidence->'admissionGeneration') <> 'number'
           OR (p_evidence->>'admissionGeneration')::bigint <> v_admission.generation
           OR p_evidence->'expectedWriterGeneration' IS DISTINCT FROM
             COALESCE(pg_catalog.to_jsonb(p_expected_generation), 'null'::jsonb)
           OR p_evidence->'expectedWriterState' IS DISTINCT FROM
             COALESCE(pg_catalog.to_jsonb(p_expected_state), 'null'::jsonb)
           OR p_evidence->'expectedWriterCatalogDigest' IS DISTINCT FROM
             COALESCE(pg_catalog.to_jsonb(p_expected_catalog_digest), 'null'::jsonb)
           OR pg_catalog.jsonb_typeof(p_evidence->'writerGeneration') <> 'number'
           OR (p_evidence->>'writerGeneration')::bigint <> v_next_generation
           OR p_evidence->>'writerState' IS DISTINCT FROM p_target_state
           OR p_evidence->>'writerTransition' IS DISTINCT FROM v_transition THEN
          RAISE EXCEPTION 'feeding writer transition evidence violates its closed CAS contract'
            USING ERRCODE = '22023';
        END IF;

        IF NOT v_mutated THEN
          v_result := v_current;
        ELSIF v_current."tenantId" IS NULL THEN
          INSERT INTO farm.feeding_writer_authority (
            "tenantId", generation, state, "catalogDigest", "activatedBy",
            "activatedAt", evidence, "updatedAt"
          ) VALUES (
            p_tenant_id, v_next_generation, p_target_state, v_root.digest, p_actor,
            pg_catalog.clock_timestamp(), p_evidence, pg_catalog.clock_timestamp()
          )
          RETURNING * INTO STRICT v_result;
        ELSE
          UPDATE farm.feeding_writer_authority authority
             SET generation = v_next_generation,
                 state = p_target_state,
                 "catalogDigest" = v_root.digest,
                 "activatedBy" = p_actor,
                 "activatedAt" = CASE
                   WHEN p_target_state = 'active' THEN pg_catalog.clock_timestamp()
                   ELSE authority."activatedAt"
                 END,
                 evidence = p_evidence,
                 "updatedAt" = pg_catalog.clock_timestamp()
           WHERE authority."tenantId" = p_tenant_id
             AND authority.generation = p_expected_generation
             AND authority.state = p_expected_state
             AND authority."catalogDigest" = p_expected_catalog_digest
          RETURNING authority.* INTO v_result;
          GET DIAGNOSTICS v_updated = ROW_COUNT;
          IF v_updated <> 1 THEN
            RAISE EXCEPTION 'feeding writer transition CAS was lost'
              USING ERRCODE = '40001';
          END IF;
        END IF;

        IF v_mutated THEN
          INSERT INTO farm.feeding_writer_authority_history (
            "tenantId", generation, state, "catalogDigest", transition,
            "changedBy", evidence, "transitionedAt"
          ) VALUES (
            v_result."tenantId", v_result.generation, v_result.state,
            v_result."catalogDigest", v_transition, p_actor, p_evidence,
            v_result."updatedAt"
          );
        END IF;

        "tenantId" := v_result."tenantId";
        generation := v_result.generation;
        state := v_result.state;
        "catalogDigest" := v_result."catalogDigest";
        "changedBy" := v_result."activatedBy";
        evidence := v_result.evidence;
        "transitionedAt" := v_result."updatedAt";
        mutated := v_mutated;
        RETURN NEXT;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding writer transition target catalog is not admitted: %',
            p_target_catalog_digest
            USING ERRCODE = '23503';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.feeding_schedule_occurrence_matches(
        p_definition jsonb,
        p_observed_at timestamptz,
        p_timezone varchar,
        p_schedule_key varchar,
        p_due_at timestamptz,
        p_local_date date,
        p_caught_up boolean,
        p_dst_gap_adjusted boolean
      ) RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_schedule_kind varchar := p_definition->>'scheduleKind';
        v_at_minute timestamptz := pg_catalog.date_trunc('minute', p_observed_at);
        v_due_minute timestamptz := pg_catalog.date_trunc('minute', p_due_at);
        v_catch_up_minutes integer;
        v_interval_minutes integer;
        v_start timestamptz;
        v_candidate timestamptz;
        v_local timestamp;
        v_previous_local timestamp;
        v_target_minute integer;
        v_local_minute integer;
        v_previous_minute integer;
        v_period_matches boolean;
        v_expected_due timestamptz;
        v_expected_schedule_key varchar;
        v_expected_local_date date;
        v_expected_gap boolean := false;
      BEGIN
        IF p_definition IS NULL
           OR p_definition->>'capability' <> 'scheduled.v2'
           OR COALESCE((p_definition->>'enabled')::boolean, false) IS NOT TRUE
           OR p_observed_at IS NULL
           OR p_due_at IS NULL
           OR p_due_at <> v_due_minute
           OR p_due_at > v_at_minute
           OR p_schedule_key IS NULL
           OR pg_catalog.length(p_schedule_key) NOT BETWEEN 1 AND 200
           OR p_timezone IS NULL
           OR pg_catalog.length(p_timezone) NOT BETWEEN 1 AND 64
           OR p_local_date IS NULL THEN
          RETURN false;
        END IF;

        v_catch_up_minutes := (p_definition->'misfire'->>'catchUpWindowMinutes')::integer;
        IF v_catch_up_minutes IS NULL OR v_catch_up_minutes < 0 THEN
          RETURN false;
        END IF;
        v_start := v_at_minute - pg_catalog.make_interval(mins => v_catch_up_minutes);

        IF v_schedule_kind = 'absolute_interval' THEN
          v_interval_minutes := (p_definition->>'intervalMinutes')::integer;
          IF v_interval_minutes IS NULL OR v_interval_minutes <= 0
             OR p_due_at < v_start
             OR (extract(epoch FROM p_due_at)::bigint
                  % (v_interval_minutes::bigint * 60)) <> 0 THEN
            RETURN false;
          END IF;
          v_expected_due := p_due_at;
          v_expected_schedule_key := pg_catalog.to_char(
            p_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          );
          v_expected_local_date := (p_due_at AT TIME ZONE p_timezone)::date;
        ELSIF v_schedule_kind IN ('local_daily', 'local_weekly', 'local_monthly') THEN
          IF p_definition->>'localTime' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' THEN
            RETURN false;
          END IF;
          v_target_minute := pg_catalog.substring(p_definition->>'localTime', 1, 2)::integer * 60
            + pg_catalog.substring(p_definition->>'localTime', 4, 2)::integer;

          FOR v_candidate IN
            SELECT minute
              FROM pg_catalog.generate_series(v_start, v_at_minute, INTERVAL '1 minute') minute
             ORDER BY minute
          LOOP
            v_local := v_candidate AT TIME ZONE p_timezone;
            v_local_minute := extract(hour FROM v_local)::integer * 60
              + extract(minute FROM v_local)::integer;
            v_period_matches :=
              v_schedule_kind = 'local_daily'
              OR (
                v_schedule_kind = 'local_weekly'
                AND extract(isodow FROM v_local)::integer
                    = (p_definition->>'localWeekday')::integer
              )
              OR (
                v_schedule_kind = 'local_monthly'
                AND extract(day FROM v_local)::integer
                    = (p_definition->>'localDayOfMonth')::integer
              );

            IF v_period_matches AND v_local_minute = v_target_minute THEN
              v_expected_due := v_candidate;
              v_expected_local_date := v_local::date;
              v_expected_gap := false;
              EXIT;
            END IF;

            IF v_previous_local IS NOT NULL
               AND v_previous_local::date = v_local::date
               AND v_period_matches THEN
              v_previous_minute := extract(hour FROM v_previous_local)::integer * 60
                + extract(minute FROM v_previous_local)::integer;
              IF v_previous_minute < v_target_minute AND v_local_minute > v_target_minute THEN
                v_expected_due := v_candidate;
                v_expected_local_date := v_local::date;
                v_expected_gap := true;
                EXIT;
              END IF;
            END IF;
            v_previous_local := v_local;
          END LOOP;

          IF v_expected_due IS NULL THEN
            RETURN false;
          END IF;
          v_expected_schedule_key := CASE
            WHEN v_schedule_kind = 'local_monthly'
              THEN pg_catalog.to_char(v_expected_local_date, 'YYYY-MM')
            ELSE v_expected_local_date::text
          END;
        ELSE
          RETURN false;
        END IF;

        RETURN p_due_at = v_expected_due
          AND p_schedule_key = v_expected_schedule_key
          AND p_local_date = v_expected_local_date
          AND p_caught_up = (v_expected_due < v_at_minute)
          AND p_dst_gap_adjusted = v_expected_gap;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.claim_feeding_job(
        p_tenant_id uuid,
        p_catalog_job varchar,
        p_schedule_key varchar,
        p_local_date date,
        p_timezone varchar,
        p_timezone_source varchar,
        p_clock_profile varchar,
        p_target_kind varchar,
        p_target_id uuid,
        p_catalog_revision varchar,
        p_catalog_digest varchar,
        p_command_digest varchar,
        p_catalog_admission_generation bigint,
        p_authority_generation bigint,
        p_target_set_digest varchar,
        p_evidence jsonb
      )
      RETURNS TABLE (
        disposition varchar,
        "operationId" uuid,
        "leaseToken" uuid,
        generation bigint,
        attempt integer,
        "leaseExpiresAt" timestamptz,
        intent jsonb,
        "resultSchema" varchar,
        "resultPayload" text,
        "resultDigest" varchar
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_catalog farm.feeding_job_catalog_entries%ROWTYPE;
        v_root farm.feeding_catalog_revisions%ROWTYPE;
        v_admission farm.feeding_catalog_admission%ROWTYPE;
        v_authority farm.feeding_writer_authority%ROWTYPE;
        v_operation_id uuid := pg_catalog.gen_random_uuid();
        v_lease_token uuid := pg_catalog.gen_random_uuid();
        v_claim farm.feeding_job_runs%ROWTYPE;
        v_target_match_count integer;
        v_dispatch_match_count integer;
      BEGIN
        IF NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid
             IS DISTINCT FROM p_tenant_id THEN
          RAISE EXCEPTION 'feeding claim tenant does not match app.current_tenant'
            USING ERRCODE = '42501';
        END IF;
        IF p_schedule_key IS NULL OR length(p_schedule_key) = 0 OR length(p_schedule_key) > 200
           OR p_timezone IS NULL OR length(p_timezone) = 0 OR length(p_timezone) > 64
           OR p_command_digest !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'invalid feeding claim coordinates' USING ERRCODE = '22023';
        END IF;
        IF p_evidence IS NULL
           OR NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'schemaVersion', 'tenantId', 'actorId', 'requestId', 'jobId', 'targetKind', 'targetId',
               'siteId', 'unitId',
               'reason', 'catalogRevision', 'catalogDigest', 'catalogJobCount',
               'commandDigest', 'commandPayload', 'lockSetDigest',
               'observedAt', 'dueAt', 'scheduleKey', 'localDate',
               'timezone', 'caughtUp', 'dstGapAdjusted', 'timezoneSource',
               'catalogAdmissionGeneration', 'authorityGeneration', 'targetSetDigest',
               'schedulerCutDigest', 'dispatchDigest'
             ]
           )
           OR p_evidence->>'schemaVersion' <> 'feeding-operation-intent/v1'
           OR p_evidence->>'tenantId' IS DISTINCT FROM p_tenant_id::text
           OR p_evidence->>'jobId' IS DISTINCT FROM p_catalog_job
           OR p_evidence->>'targetKind' IS DISTINCT FROM p_target_kind
           OR p_evidence->>'catalogRevision' IS DISTINCT FROM p_catalog_revision
           OR p_evidence->>'catalogDigest' IS DISTINCT FROM p_catalog_digest
           OR p_evidence->>'commandDigest' IS DISTINCT FROM p_command_digest
           OR pg_catalog.jsonb_typeof(p_evidence->'commandPayload') <> 'object'
           OR p_evidence->'commandPayload'->>'jobId' IS DISTINCT FROM p_catalog_job
           OR p_evidence->'commandPayload'->>'tenantId' IS DISTINCT FROM p_tenant_id::text
           OR p_evidence->>'commandDigest' IS DISTINCT FROM
                ${feedingOperationCommandDigestSqlV1("p_evidence->'commandPayload'")}
           OR p_evidence->>'lockSetDigest' !~ '^[0-9a-f]{64}$'
           OR p_evidence->>'lockSetDigest' IS DISTINCT FROM ${feedingOperationLockSetDigestSqlV1({
             tenantIdTextSql: 'p_tenant_id::text',
             jobIdTextSql: 'p_catalog_job::text',
             targetKindTextSql: 'p_target_kind::text',
             targetIdTextSql: 'p_target_id::text',
             localDateTextSql: 'p_local_date::text',
           })}
           OR p_evidence->>'scheduleKey' IS DISTINCT FROM p_schedule_key
           OR p_evidence->>'localDate' IS DISTINCT FROM p_local_date::text
           OR p_evidence->>'timezone' IS DISTINCT FROM p_timezone
           OR p_evidence->>'timezoneSource' IS DISTINCT FROM p_timezone_source
           OR pg_catalog.jsonb_typeof(p_evidence->'caughtUp') <> 'boolean'
           OR pg_catalog.jsonb_typeof(p_evidence->'dstGapAdjusted') <> 'boolean'
           OR (p_evidence->>'observedAt')::timestamptz IS NULL
           OR (p_evidence->>'dueAt')::timestamptz IS NULL
           OR p_evidence->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
                (p_evidence->>'observedAt')::timestamptz AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
           OR p_evidence->>'dueAt' IS DISTINCT FROM pg_catalog.to_char(
                (p_evidence->>'dueAt')::timestamptz AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
           OR (p_evidence->>'dueAt')::timestamptz > (p_evidence->>'observedAt')::timestamptz
           OR (p_evidence->>'observedAt')::timestamptz
                > pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
           OR pg_catalog.to_char(
                (p_evidence->>'dueAt')::timestamptz AT TIME ZONE p_timezone,
                'YYYY-MM-DD'
              ) IS DISTINCT FROM p_local_date::text
           OR (
             (p_target_id IS NULL AND p_evidence->'targetId' <> 'null'::jsonb)
             OR (p_target_id IS NOT NULL AND p_evidence->>'targetId' IS DISTINCT FROM p_target_id::text)
           )
           OR (
             p_target_kind = 'tenant'
             AND (
               p_evidence->'siteId' <> 'null'::jsonb
               OR p_evidence->'unitId' <> 'null'::jsonb
             )
           )
           OR (
             p_target_kind = 'site'
             AND (
               p_evidence->>'siteId' IS DISTINCT FROM p_target_id::text
               OR p_evidence->'unitId' <> 'null'::jsonb
             )
           )
           OR (
             p_target_kind = 'unit'
             AND (
               p_evidence->>'siteId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               OR p_evidence->>'unitId' IS DISTINCT FROM p_target_id::text
             )
           ) THEN
          RAISE EXCEPTION 'feeding intent evidence violates its closed identity contract'
            USING ERRCODE = '22023';
        END IF;

        SELECT * INTO STRICT v_root
          FROM farm.feeding_catalog_revisions r
         WHERE r.digest = p_catalog_digest
           AND r.revision = p_catalog_revision
         FOR SHARE;
        SELECT * INTO STRICT v_catalog
          FROM farm.feeding_job_catalog_entries e
         WHERE e."catalogDigest" = v_root.digest
           AND e.id = p_catalog_job
         FOR SHARE;
        IF NOT v_catalog.enabled
           OR v_catalog."timezoneSource" <> p_timezone_source
           OR v_catalog."clockProfile" <> p_clock_profile
           OR (v_catalog."targetCardinality" = 'site' AND (p_target_kind <> 'site' OR p_target_id IS NULL))
           OR (v_catalog."targetCardinality" = 'tenant' AND (p_target_kind <> 'tenant' OR p_target_id IS NOT NULL))
           OR (v_catalog."targetCardinality" = 'operation_target' AND (p_target_kind NOT IN ('site', 'unit') OR p_target_id IS NULL))
           OR (p_clock_profile = 'utc_global' AND p_timezone <> 'UTC')
           OR pg_catalog.jsonb_typeof(p_evidence->'catalogJobCount') <> 'number'
           OR (p_evidence->>'catalogJobCount')::integer <> v_root."jobCount"
           OR p_evidence->>'reason' IS DISTINCT FROM (
             CASE v_catalog.capability
               WHEN 'scheduled.v2' THEN 'scheduled_reconciliation'
               WHEN 'operator.manual' THEN 'operator_request'
               WHEN 'device.mobile' THEN 'device_request'
             END
           )
           OR (v_catalog.capability = 'scheduled.v2'
               AND (p_evidence->'actorId' <> 'null'::jsonb OR p_evidence->'requestId' <> 'null'::jsonb))
           OR (v_catalog.capability <> 'scheduled.v2' AND (
             pg_catalog.jsonb_typeof(p_evidence->'actorId') <> 'string'
             OR pg_catalog.length(p_evidence->>'actorId') NOT BETWEEN 1 AND 160
             OR pg_catalog.jsonb_typeof(p_evidence->'requestId') <> 'string'
             OR pg_catalog.length(p_evidence->>'requestId') NOT BETWEEN 1 AND 200
             OR p_schedule_key IS DISTINCT FROM p_evidence->>'requestId'
             OR (p_evidence->>'dueAt')::timestamptz IS DISTINCT FROM
                  pg_catalog.date_trunc(
                    'minute', (p_evidence->>'observedAt')::timestamptz
                  )
             OR (p_evidence->>'caughtUp')::boolean
             OR (p_evidence->>'dstGapAdjusted')::boolean
             OR p_evidence->'commandPayload'->>'actorId'
                  IS DISTINCT FROM p_evidence->>'actorId'
             OR p_evidence->'commandPayload'->>'requestId'
                  IS DISTINCT FROM p_evidence->>'requestId'
           )) THEN
          RAISE EXCEPTION 'feeding claim scope or evidence disagrees with catalog job %', p_catalog_job
            USING ERRCODE = '55000';
        END IF;

        SELECT * INTO STRICT v_admission
          FROM farm.feeding_catalog_admission a
         WHERE a.authority = 'feeding'
           AND a."activeDigest" = v_root.digest
         FOR SHARE;
        SELECT * INTO STRICT v_authority
          FROM farm.feeding_writer_authority a
         WHERE a."tenantId" = p_tenant_id
         FOR SHARE;
        IF v_authority."catalogDigest" <> v_admission."activeDigest"
           OR v_authority.state <> 'active' THEN
          RAISE EXCEPTION 'tenant feeding authority is not on the admitted catalog generation'
            USING ERRCODE = '55000';
        END IF;
        IF v_catalog.capability = 'scheduled.v2' THEN
          IF p_catalog_admission_generation IS NULL
             OR p_authority_generation IS NULL
             OR p_target_set_digest !~ '^[0-9a-f]{64}$'
             OR p_evidence->>'schedulerCutDigest' !~ '^[0-9a-f]{64}$'
             OR p_evidence->>'dispatchDigest' !~ '^[0-9a-f]{64}$'
             OR pg_catalog.jsonb_typeof(p_evidence->'catalogAdmissionGeneration') <> 'number'
             OR pg_catalog.jsonb_typeof(p_evidence->'authorityGeneration') <> 'number'
             OR pg_catalog.jsonb_typeof(p_evidence->'targetSetDigest') <> 'string'
             OR pg_catalog.jsonb_typeof(p_evidence->'schedulerCutDigest') <> 'string'
             OR (p_evidence->>'catalogAdmissionGeneration')::bigint
                  <> p_catalog_admission_generation
             OR (p_evidence->>'authorityGeneration')::bigint <> p_authority_generation
             OR p_evidence->>'targetSetDigest' IS DISTINCT FROM p_target_set_digest
             OR v_admission.generation <> p_catalog_admission_generation
             OR v_authority.generation <> p_authority_generation THEN
            RAISE EXCEPTION 'feeding scheduler cut generation is stale or malformed'
              USING ERRCODE = '55000';
          END IF;
          IF (
               p_target_kind = 'tenant'
               AND NOT farm.jsonb_has_exact_keys(
                 p_evidence->'commandPayload', ARRAY['jobId', 'tenantId']
               )
             ) OR (
               p_target_kind = 'site'
               AND (
                 NOT farm.jsonb_has_exact_keys(
                   p_evidence->'commandPayload', ARRAY['jobId', 'tenantId', 'siteId']
                 )
                 OR p_evidence->'commandPayload'->>'siteId'
                      IS DISTINCT FROM p_target_id::text
               )
             ) THEN
            RAISE EXCEPTION 'feeding scheduled command payload differs from its target authority'
              USING ERRCODE = '22023';
          END IF;
          SELECT count(*)::integer INTO v_target_match_count
            FROM farm.compile_feeding_scheduler_cut(
              p_catalog_revision,
              p_catalog_digest,
              (p_evidence->>'observedAt')::timestamptz
            ) target
           WHERE target."rowKind" = 'task'
             AND target."catalogJob" = p_catalog_job
             AND target."tenantId" = p_tenant_id
             AND target."targetKind" = p_target_kind
             AND target."targetId" IS NOT DISTINCT FROM p_target_id
             AND target.timezone = p_timezone
             AND target."authorityGeneration" = p_authority_generation
             AND target."catalogAdmissionGeneration" = p_catalog_admission_generation
             AND target."targetSetDigest" = p_target_set_digest
             AND target."cutDigest" = p_evidence->>'schedulerCutDigest';
          IF v_target_match_count <> 1 THEN
            RAISE EXCEPTION 'feeding scheduler cut target set is stale'
              USING ERRCODE = '55000';
          END IF;
          SELECT count(*)::integer INTO v_dispatch_match_count
            FROM farm.feeding_schedule_dispatches dispatch
           WHERE dispatch.status = 'leased'
             AND dispatch."leaseExpiresAt" > pg_catalog.clock_timestamp()
             AND dispatch."tenantId" = p_tenant_id
             AND dispatch."catalogJob" = p_catalog_job
             AND dispatch."targetKind" = p_target_kind
             AND dispatch."targetId" IS NOT DISTINCT FROM p_target_id
             AND dispatch."scheduleKey" = p_schedule_key
             AND dispatch."localDate" = p_local_date
             AND dispatch."dueAt" = (p_evidence->>'dueAt')::timestamptz
             AND dispatch."catalogDigest" = p_catalog_digest
             AND dispatch."catalogAdmissionGeneration" = p_catalog_admission_generation
             AND dispatch."authorityGeneration" = p_authority_generation
             AND dispatch."targetSetDigest" = p_target_set_digest
             AND dispatch."schedulerCutDigest" = p_evidence->>'schedulerCutDigest'
             AND dispatch."commandDigest" = p_command_digest
             AND dispatch."dispatchDigest" = p_evidence->>'dispatchDigest';
          IF v_dispatch_match_count <> 1 THEN
            RAISE EXCEPTION 'feeding scheduled claim has no exact leased dispatch authority'
              USING ERRCODE = '55000';
          END IF;
        ELSIF p_catalog_admission_generation IS NOT NULL
           OR p_authority_generation IS NOT NULL
           OR p_target_set_digest IS NOT NULL
           OR p_evidence->'catalogAdmissionGeneration' <> 'null'::jsonb
           OR p_evidence->'authorityGeneration' <> 'null'::jsonb
           OR p_evidence->'targetSetDigest' <> 'null'::jsonb
           OR p_evidence->'schedulerCutDigest' <> 'null'::jsonb
           OR p_evidence->'dispatchDigest' <> 'null'::jsonb THEN
          RAISE EXCEPTION 'on-demand feeding claim cannot present a scheduler cut'
            USING ERRCODE = '22023';
        END IF;

        IF (
             p_catalog_job = 'v2.forecast.refresh'
             AND p_evidence->'commandPayload'->>'siteId' IS DISTINCT FROM p_target_id::text
           ) OR (
             p_catalog_job IN ('manual.day-plan.regenerate', 'manual.feed.transition')
             AND p_evidence->'commandPayload'->>'unitId' IS DISTINCT FROM p_target_id::text
           ) THEN
          RAISE EXCEPTION 'feeding command payload differs from its direct target authority'
            USING ERRCODE = '22023';
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          p_tenant_id::text || ':' || p_catalog_job || ':' ||
          CASE
            WHEN v_catalog.capability = 'scheduled.v2'
              THEN p_target_kind || ':' || COALESCE(p_target_id::text, 'tenant') || ':'
            ELSE 'request:'
          END || p_schedule_key,
          0
        ));
        SELECT * INTO v_claim
          FROM farm.feeding_job_runs r
         WHERE r."tenantId" = p_tenant_id
           AND r."catalogJob" = p_catalog_job
           AND r."scheduleKey" = p_schedule_key
           AND (
             v_catalog.capability <> 'scheduled.v2'
             OR (
               r."targetKind" = p_target_kind
               AND r."targetId" IS NOT DISTINCT FROM p_target_id
             )
           )
         FOR UPDATE;

        IF FOUND THEN
          IF v_claim.evidence->'intent' IS NULL
             OR v_claim.evidence->'intent'->>'operationId'
                  IS DISTINCT FROM v_claim."operationId"::text
             OR (v_claim.evidence->'intent'->>'generation')::bigint
                  IS DISTINCT FROM v_claim.generation
             OR v_claim.evidence->'intent'->>'tenantId'
                  IS DISTINCT FROM v_claim."tenantId"::text
             OR v_claim.evidence->'intent'->>'jobId'
                  IS DISTINCT FROM v_claim."catalogJob"
             OR v_claim.evidence->'intent'->>'targetKind'
                  IS DISTINCT FROM v_claim."targetKind"
             OR v_claim.evidence->'intent'->>'targetId'
                  IS DISTINCT FROM v_claim."targetId"::text
             OR v_claim.evidence->'intent'->>'scheduleKey'
                  IS DISTINCT FROM v_claim."scheduleKey"
             OR v_claim.evidence->'intent'->>'localDate'
                  IS DISTINCT FROM v_claim."localDate"::text
             OR v_claim.evidence->'intent'->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
                  v_claim."observedAt" AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
             OR v_claim.evidence->'intent'->>'dueAt' IS DISTINCT FROM pg_catalog.to_char(
                  v_claim."dueAt" AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
             OR (v_claim.evidence->'intent'->>'caughtUp')::boolean
                  IS DISTINCT FROM v_claim."caughtUp"
             OR (v_claim.evidence->'intent'->>'dstGapAdjusted')::boolean
                  IS DISTINCT FROM v_claim."dstGapAdjusted"
             OR v_claim.evidence->'intent'->>'timezone' IS DISTINCT FROM v_claim.timezone
             OR v_claim.evidence->'intent'->>'timezoneSource'
                  IS DISTINCT FROM v_claim."timezoneSource"
             OR v_claim.evidence->'intent'->>'catalogDigest'
                  IS DISTINCT FROM v_claim."catalogDigest"
             OR v_claim.evidence->'intent'->>'commandDigest'
                  IS DISTINCT FROM v_claim."commandDigest"
             OR pg_catalog.jsonb_typeof(
                  v_claim.evidence->'intent'->'commandPayload'
                ) <> 'object'
             OR v_claim.evidence->'intent'->>'commandDigest' IS DISTINCT FROM
                  ${feedingOperationCommandDigestSqlV1(
                    "v_claim.evidence->'intent'->'commandPayload'",
                  )}
             OR v_claim.evidence->'intent'->>'lockSetDigest' IS DISTINCT FROM ${feedingOperationLockSetDigestSqlV1(
               {
                 tenantIdTextSql: 'v_claim."tenantId"::text',
                 jobIdTextSql: 'v_claim."catalogJob"::text',
                 targetKindTextSql: 'v_claim."targetKind"::text',
                 targetIdTextSql: 'v_claim."targetId"::text',
                 localDateTextSql: 'v_claim."localDate"::text',
               },
             )} THEN
            RAISE EXCEPTION 'feeding persisted intent differs from its operation row'
              USING ERRCODE = '55000';
          END IF;
          IF v_claim."catalogDigest" IS DISTINCT FROM v_root.digest
             OR v_claim.generation IS DISTINCT FROM v_authority.generation
             OR v_claim.evidence->'intent'->>'catalogDigest' IS DISTINCT FROM v_root.digest
             OR (
               v_catalog.capability = 'scheduled.v2'
               AND (
                 v_claim."catalogAdmissionGeneration"
                   IS DISTINCT FROM p_catalog_admission_generation
                 OR v_claim."authorityGeneration" IS DISTINCT FROM p_authority_generation
                 OR v_claim."targetSetDigest" IS DISTINCT FROM p_target_set_digest
                 OR v_claim."schedulerCutDigest"
                   IS DISTINCT FROM p_evidence->>'schedulerCutDigest'
                 OR v_claim.evidence->'intent'->>'dispatchDigest'
                   IS DISTINCT FROM p_evidence->>'dispatchDigest'
               )
             ) THEN
            RAISE EXCEPTION 'feeding request identity belongs to a stale catalog or writer epoch'
              USING ERRCODE = '55000';
          END IF;
          IF v_claim."commandDigest" <> p_command_digest
             OR v_claim.evidence->'intent'->>'commandDigest' IS DISTINCT FROM p_command_digest THEN
            RAISE EXCEPTION 'feeding request identity conflicts with immutable command digest'
              USING ERRCODE = '23505';
          END IF;
          IF v_claim."targetKind" IS DISTINCT FROM p_target_kind
             OR v_claim."targetId" IS DISTINCT FROM p_target_id THEN
            RAISE EXCEPTION 'feeding request identity conflicts with immutable target coordinates'
              USING ERRCODE = '23505';
          END IF;
          IF v_claim.status = 'succeeded' THEN
            IF v_claim.evidence->'result'->>'schemaVersion'
                 IS DISTINCT FROM 'feeding-operation-result/v1'
               OR v_claim.evidence->'result'->>'operationId'
                 IS DISTINCT FROM v_claim."operationId"::text
               OR v_claim.evidence->'result'->>'jobId'
                 IS DISTINCT FROM v_claim."catalogJob"
               OR (v_claim.evidence->'result'->>'generation')::bigint
                 IS DISTINCT FROM v_claim.generation
               OR v_claim.evidence->'result'->>'catalogDigest'
                 IS DISTINCT FROM v_claim."catalogDigest"
               OR v_claim.evidence->'result'->>'resultSchema'
                 IS DISTINCT FROM v_claim."resultSchema"
               OR v_claim.evidence->'result'->>'resultDigest'
                 IS DISTINCT FROM v_claim."resultDigest" THEN
              RAISE EXCEPTION 'terminal feeding replay evidence crosses identity epochs'
                USING ERRCODE = '55000';
            END IF;
            RETURN QUERY SELECT 'replay'::varchar, v_claim."operationId", NULL::uuid,
              v_claim.generation, v_claim.attempt, v_claim."leaseExpiresAt",
              v_claim.evidence->'intent',
              v_claim."resultSchema", v_claim."resultPayload", v_claim."resultDigest"::varchar;
            RETURN;
          END IF;
          IF v_claim.status = 'leased'
             AND v_claim."leaseExpiresAt" > pg_catalog.clock_timestamp() THEN
            RETURN QUERY SELECT 'leased'::varchar, v_claim."operationId", NULL::uuid,
              v_claim.generation, v_claim.attempt, v_claim."leaseExpiresAt",
              v_claim.evidence->'intent',
              NULL::varchar, NULL::text, NULL::varchar;
            RETURN;
          END IF;

          UPDATE farm.feeding_job_runs r
             SET "leaseToken" = v_lease_token,
                 "leaseExpiresAt" = pg_catalog.clock_timestamp()
                   + pg_catalog.make_interval(secs => v_catalog."leaseSeconds"),
                 attempt = r.attempt + 1,
                 status = 'leased',
                 "resultSchema" = NULL,
                 "resultPayload" = NULL,
                 "resultDigest" = NULL,
                 "startedAt" = pg_catalog.clock_timestamp(),
                 "completedAt" = NULL,
                 "updatedAt" = pg_catalog.clock_timestamp()
           WHERE r.id = v_claim.id
          RETURNING r.* INTO v_claim;
        ELSE
          INSERT INTO farm.feeding_job_runs (
            "tenantId", generation, capability, "catalogJob", "scheduleKind",
            "clockProfile", "targetKind", "targetId", "scheduleKey", "localDate",
            "observedAt", "dueAt", "caughtUp", "dstGapAdjusted",
            timezone, "timezoneSource", "catalogDigest", "catalogAdmissionGeneration",
            "authorityGeneration", "targetSetDigest", "commandDigest",
            "schedulerCutDigest",
            "operationId", "leaseToken", "leaseExpiresAt", attempt, status,
            evidence, "startedAt", "completedAt", "updatedAt"
          ) VALUES (
            p_tenant_id, v_authority.generation, v_catalog.capability, v_catalog.id,
            v_catalog."scheduleKind", v_catalog."clockProfile", p_target_kind, p_target_id,
            p_schedule_key, p_local_date, (p_evidence->>'observedAt')::timestamptz,
            (p_evidence->>'dueAt')::timestamptz, (p_evidence->>'caughtUp')::boolean,
            (p_evidence->>'dstGapAdjusted')::boolean, p_timezone, v_catalog."timezoneSource",
            v_root.digest, p_catalog_admission_generation, p_authority_generation,
            p_target_set_digest, p_command_digest,
            p_evidence->>'schedulerCutDigest', v_operation_id, v_lease_token,
            pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_catalog."leaseSeconds"),
            1, 'leased', pg_catalog.jsonb_build_object(
              'intent', p_evidence || pg_catalog.jsonb_build_object(
                'operationId', v_operation_id, 'generation', v_authority.generation
              )
            ), pg_catalog.clock_timestamp(), NULL, pg_catalog.clock_timestamp()
          ) RETURNING * INTO v_claim;
        END IF;

        INSERT INTO farm.feeding_job_run_transitions (
          "operationId", "tenantId", generation, attempt, transition, evidence
        ) VALUES
          (v_claim."operationId", v_claim."tenantId", v_claim.generation,
           v_claim.attempt, 'intent_created', v_claim.evidence->'intent'),
          (v_claim."operationId", v_claim."tenantId", v_claim.generation,
           v_claim.attempt, 'lease_acquired',
           pg_catalog.jsonb_build_object('leaseExpiresAt', v_claim."leaseExpiresAt"));

        RETURN QUERY SELECT 'execute'::varchar, v_claim."operationId", v_claim."leaseToken",
          v_claim.generation, v_claim.attempt, v_claim."leaseExpiresAt",
          v_claim.evidence->'intent',
          NULL::varchar, NULL::text, NULL::varchar;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding catalog artifact, admission, or tenant authority is missing'
            USING ERRCODE = '55000';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.complete_feeding_job(
        p_operation_id uuid,
        p_lease_token uuid,
        p_catalog_revision varchar,
        p_catalog_digest varchar,
        p_result_schema varchar,
        p_result_payload text,
        p_result_digest varchar,
        p_evidence jsonb
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_completed farm.feeding_job_runs%ROWTYPE;
      BEGIN
        IF p_evidence IS NULL
           OR NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'schemaVersion', 'operationId', 'jobId', 'generation', 'outcome',
               'catalogRevision', 'catalogDigest', 'resultSchema', 'resultDigest',
               'operationEnvelopeDigest'
             ]
           )
           OR p_evidence->>'schemaVersion' <> 'feeding-operation-result/v1'
           OR p_evidence->>'operationId' IS DISTINCT FROM p_operation_id::text
           OR p_evidence->>'outcome' <> 'succeeded'
           OR p_evidence->>'catalogRevision' IS DISTINCT FROM p_catalog_revision
           OR p_evidence->>'catalogDigest' IS DISTINCT FROM p_catalog_digest
           OR p_evidence->>'resultSchema' IS DISTINCT FROM p_result_schema
           OR p_evidence->>'resultDigest' IS DISTINCT FROM p_result_digest
           OR p_evidence->>'operationEnvelopeDigest' !~ '^[0-9a-f]{64}$'
           OR p_result_schema !~ '^feeding-operation-result/[a-z][a-z0-9.-]{4,159}/v1$'
           OR pg_catalog.length(p_result_schema) > 200
           OR p_result_payload IS NULL
           OR pg_catalog.octet_length(p_result_payload)
                NOT BETWEEN 2 AND ${FEEDING_RESULT_PORTABILITY_V1.maxPayloadBytes}
           OR p_result_payload::jsonb IS NULL
           OR NOT farm.is_valid_feeding_result_payload(p_result_payload::jsonb)
           OR p_result_payload IS DISTINCT FROM
             farm.canonical_feeding_json(p_result_payload::jsonb)
           OR p_result_digest !~ '^[0-9a-f]{64}$'
           OR p_result_digest IS DISTINCT FROM
             farm.feeding_result_digest(p_result_schema, p_result_payload)
           OR pg_catalog.jsonb_typeof(p_evidence->'generation') <> 'number' THEN
          RAISE EXCEPTION 'feeding completion evidence violates its closed identity contract'
            USING ERRCODE = '22023';
        END IF;
        UPDATE farm.feeding_job_runs r
           SET status = 'succeeded',
               evidence = pg_catalog.jsonb_build_object(
                 'intent', r.evidence->'intent',
                 'result', p_evidence
               ),
               "resultSchema" = p_result_schema,
               "resultPayload" = p_result_payload,
               "resultDigest" = p_result_digest,
               "completedAt" = pg_catalog.clock_timestamp(),
               "updatedAt" = pg_catalog.clock_timestamp()
          FROM farm.feeding_writer_authority a,
               farm.feeding_catalog_admission admission,
               farm.feeding_catalog_revisions root
         WHERE r."operationId" = p_operation_id
           AND r."leaseToken" = p_lease_token
           AND r.status = 'leased'
           AND r."leaseExpiresAt" > pg_catalog.clock_timestamp()
           AND r."catalogDigest" = p_catalog_digest
           AND r."tenantId" = NULLIF(
             pg_catalog.current_setting('app.current_tenant', true), ''
           )::uuid
           AND p_evidence->>'jobId' = r."catalogJob"
           AND p_result_schema = 'feeding-operation-result/' || r."catalogJob" || '/v1'
           AND (p_evidence->>'generation')::bigint = r.generation
           AND p_evidence->>'operationEnvelopeDigest' = ${operationEnvelopeDigestSql('r')}
           AND root.digest = r."catalogDigest"
           AND root.revision = p_catalog_revision
           AND admission.authority = 'feeding'
           AND admission."activeDigest" = r."catalogDigest"
           AND a."tenantId" = r."tenantId"
           AND a.state = 'active'
           AND a.generation = r.generation
           AND a."catalogDigest" = r."catalogDigest"
        RETURNING r.* INTO v_completed;
        IF NOT FOUND THEN
          RETURN false;
        END IF;
        INSERT INTO farm.feeding_job_run_transitions (
          "operationId", "tenantId", generation, attempt, transition, evidence
        ) VALUES (
          v_completed."operationId", v_completed."tenantId", v_completed.generation,
          v_completed.attempt, 'succeeded', p_evidence
        );
        RETURN true;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.fail_feeding_job(
        p_operation_id uuid,
        p_lease_token uuid,
        p_catalog_revision varchar,
        p_catalog_digest varchar,
        p_evidence jsonb
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_failed farm.feeding_job_runs%ROWTYPE;
      BEGIN
        IF p_evidence IS NULL
           OR NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'schemaVersion', 'operationId', 'jobId', 'generation', 'outcome',
               'catalogRevision', 'catalogDigest', 'errorCode', 'errorClass',
               'safeMessage', 'errorDigest', 'operationEnvelopeDigest'
             ]
           )
           OR p_evidence->>'schemaVersion' <> 'feeding-operation-result/v1'
           OR p_evidence->>'operationId' IS DISTINCT FROM p_operation_id::text
           OR p_evidence->>'outcome' <> 'failed'
           OR p_evidence->>'catalogRevision' IS DISTINCT FROM p_catalog_revision
           OR p_evidence->>'catalogDigest' IS DISTINCT FROM p_catalog_digest
           OR pg_catalog.jsonb_typeof(p_evidence->'generation') <> 'number'
           OR p_evidence->>'errorCode' NOT IN (
             'FEEDING_AUTHORITY_REJECTED', 'FEEDING_INPUT_REJECTED',
             'FEEDING_STATE_CONFLICT', 'FEEDING_DEPENDENCY_FAILED',
             'FEEDING_INTERNAL_FAILED'
           )
           OR p_evidence->>'errorClass' NOT IN (
             'authority', 'validation', 'conflict', 'dependency', 'internal'
           )
           OR pg_catalog.length(p_evidence->>'safeMessage') NOT BETWEEN 1 AND 160
           OR p_evidence->>'errorDigest' !~ '^[0-9a-f]{64}$'
           OR p_evidence->>'operationEnvelopeDigest' !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'feeding failure evidence violates its closed identity contract'
            USING ERRCODE = '22023';
        END IF;
        UPDATE farm.feeding_job_runs r
           SET status = 'failed',
               evidence = pg_catalog.jsonb_build_object(
                 'intent', r.evidence->'intent',
                 'failure', p_evidence
               ),
               "completedAt" = pg_catalog.clock_timestamp(),
               "updatedAt" = pg_catalog.clock_timestamp()
          FROM farm.feeding_writer_authority a,
               farm.feeding_catalog_admission admission,
               farm.feeding_catalog_revisions root
         WHERE r."operationId" = p_operation_id
           AND r."leaseToken" = p_lease_token
           AND r.status = 'leased'
           AND r."leaseExpiresAt" > pg_catalog.clock_timestamp()
           AND r."catalogDigest" = p_catalog_digest
           AND r."tenantId" = NULLIF(
             pg_catalog.current_setting('app.current_tenant', true), ''
           )::uuid
           AND p_evidence->>'jobId' = r."catalogJob"
           AND (p_evidence->>'generation')::bigint = r.generation
           AND p_evidence->>'operationEnvelopeDigest' = ${operationEnvelopeDigestSql('r')}
           AND root.digest = r."catalogDigest"
           AND root.revision = p_catalog_revision
           AND admission.authority = 'feeding'
           AND admission."activeDigest" = r."catalogDigest"
           AND a."tenantId" = r."tenantId"
           AND a.state = 'active'
           AND a.generation = r.generation
           AND a."catalogDigest" = r."catalogDigest"
        RETURNING r.* INTO v_failed;
        IF NOT FOUND THEN
          RETURN false;
        END IF;
        INSERT INTO farm.feeding_job_run_transitions (
          "operationId", "tenantId", generation, attempt, transition, evidence
        ) VALUES (
          v_failed."operationId", v_failed."tenantId", v_failed.generation,
          v_failed.attempt, 'failed', p_evidence
        );
        RETURN true;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.compile_feeding_job_targets(
        p_catalog_job varchar,
        p_catalog_revision varchar,
        p_catalog_digest varchar,
        p_observed_at timestamptz
      )
      RETURNS TABLE (
        "tenantId" uuid,
        "targetKind" varchar,
        "targetId" uuid,
        timezone varchar,
        "authorityGeneration" bigint,
        "catalogDigest" varchar,
        "catalogAdmissionGeneration" bigint,
        "timezoneSource" varchar,
        "targetSetDigest" varchar,
        "observedAt" timestamptz
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_catalog farm.feeding_job_catalog_entries%ROWTYPE;
        v_admission farm.feeding_catalog_admission%ROWTYPE;
        v_authority farm.feeding_writer_authority%ROWTYPE;
        v_mapping record;
        v_expected_schema text;
        v_site record;
        v_targets jsonb := '[]'::jsonb;
        v_target jsonb;
        v_target_set_digest varchar;
        v_original_tenant text := COALESCE(
          pg_catalog.current_setting('app.current_tenant', true), ''
        );
      BEGIN
        IF p_observed_at IS NULL THEN
          RAISE EXCEPTION 'feeding target compiler requires an immutable observedAt'
            USING ERRCODE = '22023';
        END IF;
        SELECT admission.* INTO STRICT v_admission
          FROM farm.feeding_catalog_admission admission
         WHERE admission.authority = 'feeding'
           AND admission."activeDigest" = p_catalog_digest
         FOR SHARE;
        SELECT entry.* INTO STRICT v_catalog
          FROM farm.feeding_job_catalog_entries entry
          JOIN farm.feeding_catalog_revisions root
            ON root.digest = entry."catalogDigest"
         WHERE entry."catalogDigest" = p_catalog_digest
           AND root.revision = p_catalog_revision
           AND entry.id = p_catalog_job
           AND entry.capability = 'scheduled.v2'
           AND entry.enabled = true;

        FOR v_mapping IN
          SELECT mapping.*
            FROM platform.list_active_tenant_schema_mappings() mapping
           ORDER BY mapping.tenant_id
        LOOP
          IF NOT v_mapping.schema_exists OR NOT v_mapping.committed_proof THEN
            RAISE EXCEPTION 'feeding target compiler rejects uncommitted tenant mapping %/%',
              v_mapping.tenant_id, v_mapping.schema_name USING ERRCODE = '55000';
          END IF;
          v_expected_schema := 'tenant_' || pg_catalog.substr(
            pg_catalog.replace(v_mapping.tenant_id::text, '-', ''), 1, 16
          );
          IF v_mapping.schema_name !~ '^tenant_[a-f0-9]{16}$'
             OR v_mapping.schema_name <> v_expected_schema THEN
            RAISE EXCEPTION 'feeding target compiler found invalid tenant schema authority for %',
              v_mapping.tenant_id USING ERRCODE = '55000';
          END IF;
          SELECT authority.* INTO STRICT v_authority
            FROM farm.feeding_writer_authority authority
           WHERE authority."tenantId" = v_mapping.tenant_id
             AND authority.state = 'active'
             AND authority."catalogDigest" = v_admission."activeDigest"
           FOR SHARE;

          IF v_catalog."targetCardinality" = 'tenant' THEN
            IF v_catalog."clockProfile" <> 'utc_global'
               OR v_catalog."timezoneSource" <> 'utc_global' THEN
              RAISE EXCEPTION 'tenant target job % is not governed by utc_global', p_catalog_job
                USING ERRCODE = '55000';
            END IF;
            v_targets := v_targets || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'tenantId', v_authority."tenantId",
                'targetKind', 'tenant',
                'targetId', NULL,
                'timezone', 'UTC',
                'authorityGeneration', v_authority.generation
              )
            );
          ELSIF v_catalog."targetCardinality" = 'site' THEN
            IF v_catalog."clockProfile" <> 'site_local'
               OR v_catalog."timezoneSource" <> 'tenant_site_catalog' THEN
              RAISE EXCEPTION 'site target job % is not governed by tenant_site_catalog', p_catalog_job
                USING ERRCODE = '55000';
            END IF;
            PERFORM pg_catalog.set_config(
              'app.current_tenant', v_authority."tenantId"::text, true
            );
            FOR v_site IN EXECUTE pg_catalog.format(
              'SELECT id, timezone FROM %I.sites WHERE "tenantId" = $1 AND "isActive" = true AND "isDeleted" = false ORDER BY id',
              v_mapping.schema_name
            ) USING v_authority."tenantId"
            LOOP
              IF v_site.timezone IS NULL OR pg_catalog.length(v_site.timezone) NOT BETWEEN 1 AND 64 THEN
                RAISE EXCEPTION 'feeding target site % has no governed timezone', v_site.id
                  USING ERRCODE = '55000';
              END IF;
              v_targets := v_targets || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                  'tenantId', v_authority."tenantId",
                  'targetKind', 'site',
                  'targetId', v_site.id,
                  'timezone', v_site.timezone,
                  'authorityGeneration', v_authority.generation
                )
              );
            END LOOP;
            PERFORM pg_catalog.set_config('app.current_tenant', v_original_tenant, true);
          ELSE
            RAISE EXCEPTION 'scheduled feeding job % has unsupported target cardinality %',
              p_catalog_job, v_catalog."targetCardinality" USING ERRCODE = '55000';
          END IF;
        END LOOP;

        IF EXISTS (
          SELECT 1
            FROM farm.feeding_writer_authority authority
           WHERE authority.state = 'active'
             AND authority."catalogDigest" = v_admission."activeDigest"
             AND NOT EXISTS (
               SELECT 1
                 FROM platform.list_active_tenant_schema_mappings() mapping
                WHERE mapping.tenant_id = authority."tenantId"
                  AND mapping.schema_exists
                  AND mapping.committed_proof
             )
        ) THEN
          RAISE EXCEPTION 'feeding writer authority and active tenant mappings are not set-equal'
            USING ERRCODE = '55000';
        END IF;

        v_target_set_digest := pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(farm.canonical_feeding_json(v_targets), 'UTF8')
          ),
          'hex'
        );
        FOR v_target IN
          SELECT target.value
            FROM pg_catalog.jsonb_array_elements(v_targets) target(value)
        LOOP
          "tenantId" := (v_target->>'tenantId')::uuid;
          "targetKind" := v_target->>'targetKind';
          "targetId" := NULLIF(v_target->>'targetId', '')::uuid;
          timezone := v_target->>'timezone';
          "authorityGeneration" := (v_target->>'authorityGeneration')::bigint;
          "catalogDigest" := v_admission."activeDigest"::varchar;
          "catalogAdmissionGeneration" := v_admission.generation;
          "timezoneSource" := v_catalog."timezoneSource";
          "targetSetDigest" := v_target_set_digest;
          "observedAt" := p_observed_at;
          RETURN NEXT;
        END LOOP;
        PERFORM pg_catalog.set_config('app.current_tenant', v_original_tenant, true);
      EXCEPTION WHEN OTHERS THEN
        PERFORM pg_catalog.set_config('app.current_tenant', v_original_tenant, true);
        RAISE;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.compile_feeding_scheduler_cut(
        p_catalog_revision varchar,
        p_catalog_digest varchar,
        p_observed_at timestamptz
      )
      RETURNS TABLE (
        "rowKind" varchar,
        "catalogJob" varchar,
        "jobTargetCount" integer,
        "jobTargetRoot" varchar,
        "tenantId" uuid,
        "targetKind" varchar,
        "targetId" uuid,
        timezone varchar,
        "authorityGeneration" bigint,
        "catalogDigest" varchar,
        "catalogAdmissionGeneration" bigint,
        "timezoneSource" varchar,
        "targetSetDigest" varchar,
        "observedAt" timestamptz,
        "cutDigest" varchar
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_job record;
        v_target record;
        v_task jsonb;
        v_tasks jsonb := '[]'::jsonb;
        v_job_tasks jsonb;
        v_job_projection jsonb;
        v_job_projections jsonb := '[]'::jsonb;
        v_job_target_count integer;
        v_job_target_root varchar;
        v_cut_digest varchar;
        v_catalog_admission_generation bigint;
      BEGIN
        IF p_observed_at IS NULL THEN
          RAISE EXCEPTION 'feeding scheduler cut requires immutable observedAt'
            USING ERRCODE = '22023';
        END IF;
        SELECT admission.generation INTO STRICT v_catalog_admission_generation
          FROM farm.feeding_catalog_admission admission
          JOIN farm.feeding_catalog_revisions root
            ON root.digest = admission."activeDigest"
         WHERE admission.authority = 'feeding'
           AND admission."activeDigest" = p_catalog_digest
           AND root.revision = p_catalog_revision
         FOR SHARE;
        FOR v_job IN
          SELECT entry.id
            FROM farm.feeding_job_catalog_entries entry
            JOIN farm.feeding_catalog_revisions root
              ON root.digest = entry."catalogDigest"
           WHERE entry."catalogDigest" = p_catalog_digest
             AND root.revision = p_catalog_revision
             AND entry.capability = 'scheduled.v2'
             AND entry.enabled = true
           ORDER BY entry.id
        LOOP
          v_job_target_count := 0;
          v_job_tasks := '[]'::jsonb;
          FOR v_target IN
            SELECT target.*
              FROM farm.compile_feeding_job_targets(
                v_job.id,
                p_catalog_revision,
                p_catalog_digest,
                p_observed_at
              ) target
             ORDER BY target."tenantId", target."targetKind", target."targetId" NULLS FIRST
          LOOP
            v_job_target_count := v_job_target_count + 1;
            v_task := pg_catalog.jsonb_build_object(
              'catalogJob', v_job.id,
              'tenantId', v_target."tenantId",
              'targetKind', v_target."targetKind",
              'targetId', v_target."targetId",
              'timezone', v_target.timezone,
              'authorityGeneration', v_target."authorityGeneration",
              'catalogAdmissionGeneration', v_target."catalogAdmissionGeneration",
              'timezoneSource', v_target."timezoneSource",
              'targetSetDigest', v_target."targetSetDigest"
            );
            v_tasks := v_tasks || pg_catalog.jsonb_build_array(v_task);
            v_job_tasks := v_job_tasks || pg_catalog.jsonb_build_array(v_task);
          END LOOP;
          v_job_target_root := pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                farm.canonical_feeding_json(
                  pg_catalog.jsonb_build_object(
                    'domain', 'aquaculture.feeding-scheduler-job-target-projection',
                    'schemaVersion', 'feeding-scheduler-job-target-projection/v1',
                    'value', pg_catalog.jsonb_build_object(
                      'catalogJob', v_job.id,
                      'targets', v_job_tasks
                    )
                  )
                ),
                'UTF8'
              )
            ),
            'hex'
          );
          v_job_projections := v_job_projections || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'catalogJob', v_job.id,
              'jobTargetCount', v_job_target_count,
              'jobTargetRoot', v_job_target_root
            )
          );
        END LOOP;
        IF pg_catalog.jsonb_array_length(v_job_projections) = 0 THEN
          RAISE EXCEPTION 'feeding scheduler catalog has no enabled scheduled jobs'
            USING ERRCODE = '55000';
        END IF;
        v_cut_digest := pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              farm.canonical_feeding_json(
                pg_catalog.jsonb_build_object(
                  'domain', 'aquaculture.feeding-scheduler-target-cut',
                  'schemaVersion', 'feeding-scheduler-target-cut/v1',
                  'value', pg_catalog.jsonb_build_object(
                    'schemaVersion', 'feeding-scheduler-target-cut/v1',
                    'catalogRevision', p_catalog_revision,
                    'catalogDigest', p_catalog_digest,
                    'observedAt', pg_catalog.to_char(
                      p_observed_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ),
                    'jobProjections', v_job_projections,
                    'tasks', v_tasks
                  )
                )
              ),
              'UTF8'
            )
          ),
          'hex'
        );
        FOR v_job_projection IN
          SELECT projection.value
            FROM pg_catalog.jsonb_array_elements(v_job_projections) projection(value)
        LOOP
          "rowKind" := 'job_projection';
          "catalogJob" := v_job_projection->>'catalogJob';
          "jobTargetCount" := (v_job_projection->>'jobTargetCount')::integer;
          "jobTargetRoot" := v_job_projection->>'jobTargetRoot';
          "tenantId" := NULL;
          "targetKind" := NULL;
          "targetId" := NULL;
          timezone := NULL;
          "authorityGeneration" := NULL;
          "catalogDigest" := p_catalog_digest;
          "catalogAdmissionGeneration" := v_catalog_admission_generation;
          "timezoneSource" := NULL;
          "targetSetDigest" := NULL;
          "observedAt" := p_observed_at;
          "cutDigest" := v_cut_digest;
          RETURN NEXT;
        END LOOP;
        FOR v_task IN
          SELECT task.value FROM pg_catalog.jsonb_array_elements(v_tasks) task(value)
        LOOP
          "rowKind" := 'task';
          "catalogJob" := v_task->>'catalogJob';
          "jobTargetCount" := NULL;
          "jobTargetRoot" := NULL;
          "tenantId" := (v_task->>'tenantId')::uuid;
          "targetKind" := v_task->>'targetKind';
          "targetId" := NULLIF(v_task->>'targetId', '')::uuid;
          timezone := v_task->>'timezone';
          "authorityGeneration" := (v_task->>'authorityGeneration')::bigint;
          "catalogDigest" := p_catalog_digest;
          "catalogAdmissionGeneration" :=
            (v_task->>'catalogAdmissionGeneration')::bigint;
          "timezoneSource" := v_task->>'timezoneSource';
          "targetSetDigest" := v_task->>'targetSetDigest';
          "observedAt" := p_observed_at;
          "cutDigest" := v_cut_digest;
          RETURN NEXT;
        END LOOP;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.is_current_feeding_schedule_dispatch(
        p_dispatch_id uuid
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_catalog farm.feeding_job_catalog_entries%ROWTYPE;
        v_match_count integer;
      BEGIN
        SELECT dispatch.* INTO v_dispatch
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE dispatch.id = p_dispatch_id;
        IF NOT FOUND THEN
          RETURN false;
        END IF;
        SELECT entry.* INTO v_catalog
          FROM farm.feeding_job_catalog_entries entry
          JOIN farm.feeding_catalog_admission admission
            ON admission.authority = 'feeding'
           AND admission."activeDigest" = entry."catalogDigest"
           AND admission.generation = v_dispatch."catalogAdmissionGeneration"
          JOIN farm.feeding_writer_authority authority
            ON authority."tenantId" = v_dispatch."tenantId"
           AND authority.state = 'active'
           AND authority."catalogDigest" = entry."catalogDigest"
           AND authority.generation = v_dispatch."authorityGeneration"
         WHERE entry."catalogDigest" = v_dispatch."catalogDigest"
           AND entry.id = v_dispatch."catalogJob"
           AND entry.capability = 'scheduled.v2'
           AND entry.enabled = true;
        IF NOT FOUND OR NOT farm.feeding_schedule_occurrence_matches(
          v_catalog.definition,
          v_dispatch."observedAt",
          v_dispatch.timezone,
          v_dispatch."scheduleKey",
          v_dispatch."dueAt",
          v_dispatch."localDate",
          v_dispatch."caughtUp",
          v_dispatch."dstGapAdjusted"
        ) THEN
          RETURN false;
        END IF;

        SELECT count(*)::integer INTO v_match_count
          FROM farm.feeding_catalog_revisions root
          CROSS JOIN LATERAL farm.compile_feeding_scheduler_cut(
            root.revision,
            v_dispatch."catalogDigest"::varchar,
            v_dispatch."observedAt"
          ) target
         WHERE root.digest = v_dispatch."catalogDigest"
           AND target."rowKind" = 'task'
           AND target."catalogJob" = v_dispatch."catalogJob"
           AND target."tenantId" = v_dispatch."tenantId"
           AND target."targetKind" = v_dispatch."targetKind"
           AND target."targetId" IS NOT DISTINCT FROM v_dispatch."targetId"
           AND target.timezone = v_dispatch.timezone
           AND target."authorityGeneration" = v_dispatch."authorityGeneration"
           AND target."catalogAdmissionGeneration"
               = v_dispatch."catalogAdmissionGeneration"
           AND target."targetSetDigest" = v_dispatch."targetSetDigest"
           AND target."cutDigest" = v_dispatch."schedulerCutDigest";
        RETURN v_match_count = 1;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.feeding_schedule_dispatch_claimability(
        p_dispatch_id uuid,
        p_now timestamptz
      ) RETURNS varchar
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_definition jsonb;
        v_policy jsonb;
      BEGIN
        IF NOT farm.is_current_feeding_schedule_dispatch(p_dispatch_id) THEN
          RETURN 'authority_stale';
        END IF;
        SELECT dispatch.* INTO STRICT v_dispatch
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE dispatch.id = p_dispatch_id;
        SELECT entry.definition,
               root."canonicalJson"::jsonb->'dispatchRetryPolicy'
          INTO STRICT v_definition, v_policy
          FROM farm.feeding_job_catalog_entries entry
          JOIN farm.feeding_catalog_revisions root
            ON root.digest = entry."catalogDigest"
         WHERE entry."catalogDigest" = v_dispatch."catalogDigest"
           AND entry.id = v_dispatch."catalogJob";
        IF v_dispatch."expiresAt" <= p_now THEN
          RETURN 'retry_deadline_elapsed';
        END IF;
        IF v_dispatch.attempt = 0 AND (
          v_dispatch."observedAt" < p_now - pg_catalog.make_interval(
            secs => (v_policy->>'captureFreshnessSeconds')::integer
          )
          OR v_dispatch."observedAt" > p_now + pg_catalog.make_interval(
            secs => (v_policy->>'maxFutureSkewSeconds')::integer
          )
          OR v_dispatch."dueAt" < p_now - pg_catalog.make_interval(
            secs => ((v_definition->'misfire'->>'catchUpWindowMinutes')::integer * 60)
          )
        ) THEN
          RETURN 'capture_stale';
        END IF;
        RETURN 'claimable';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.enqueue_feeding_schedule_dispatch(
        p_envelope jsonb
      ) RETURNS TABLE (
        disposition varchar,
        "coordinateKind" varchar,
        "coordinateId" uuid
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_catalog farm.feeding_job_catalog_entries%ROWTYPE;
        v_admission farm.feeding_catalog_admission%ROWTYPE;
        v_authority farm.feeding_writer_authority%ROWTYPE;
        v_existing farm.feeding_schedule_dispatches%ROWTYPE;
        v_existing_run farm.feeding_job_runs%ROWTYPE;
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_tenant_id uuid;
        v_target_id uuid;
        v_observed_at timestamptz;
        v_due_at timestamptz;
        v_local_date date;
        v_expected_command_digest varchar;
        v_expected_dispatch_digest varchar;
        v_cut_match_count integer;
        v_policy jsonb;
        v_now timestamptz := pg_catalog.clock_timestamp();
      BEGIN
        IF p_envelope IS NULL
           OR NOT farm.jsonb_has_exact_keys(
             p_envelope,
             ARRAY[
               'schemaVersion', 'catalogRevision', 'catalogDigest',
               'catalogAdmissionGeneration', 'authorityGeneration', 'jobId',
               'tenantId', 'targetKind', 'targetId', 'timezone', 'timezoneSource',
               'targetSetDigest', 'observedAt', 'cutDigest', 'scheduleKey',
               'localDate', 'dueAt', 'caughtUp', 'dstGapAdjusted',
               'commandDigest', 'dispatchDigest'
             ]
           )
           OR p_envelope->>'schemaVersion' <> 'feeding-schedule-dispatch/v1'
           OR p_envelope->>'catalogDigest' !~ '^[0-9a-f]{64}$'
           OR p_envelope->>'targetSetDigest' !~ '^[0-9a-f]{64}$'
           OR p_envelope->>'cutDigest' !~ '^[0-9a-f]{64}$'
           OR p_envelope->>'commandDigest' !~ '^[0-9a-f]{64}$'
           OR p_envelope->>'dispatchDigest' !~ '^[0-9a-f]{64}$'
           OR p_envelope->>'targetKind' NOT IN ('tenant', 'site')
           OR pg_catalog.jsonb_typeof(p_envelope->'caughtUp') <> 'boolean'
           OR pg_catalog.jsonb_typeof(p_envelope->'dstGapAdjusted') <> 'boolean'
           OR pg_catalog.jsonb_typeof(p_envelope->'catalogAdmissionGeneration') <> 'number'
           OR pg_catalog.jsonb_typeof(p_envelope->'authorityGeneration') <> 'number'
           OR (p_envelope->>'catalogAdmissionGeneration')::bigint <= 0
           OR (p_envelope->>'authorityGeneration')::bigint <= 0 THEN
          RAISE EXCEPTION 'feeding schedule dispatch violates its closed envelope shape'
            USING ERRCODE = '22023';
        END IF;

        v_tenant_id := (p_envelope->>'tenantId')::uuid;
        v_target_id := NULLIF(p_envelope->>'targetId', '')::uuid;
        v_observed_at := (p_envelope->>'observedAt')::timestamptz;
        v_due_at := (p_envelope->>'dueAt')::timestamptz;
        v_local_date := (p_envelope->>'localDate')::date;
        IF p_envelope->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
             v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
           OR p_envelope->>'dueAt' IS DISTINCT FROM pg_catalog.to_char(
             v_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
           OR pg_catalog.length(p_envelope->>'timezone') NOT BETWEEN 1 AND 64
           OR pg_catalog.length(p_envelope->>'scheduleKey') NOT BETWEEN 1 AND 200
           OR (
             (p_envelope->>'targetKind' = 'tenant' AND p_envelope->'targetId' <> 'null'::jsonb)
             OR (p_envelope->>'targetKind' = 'site' AND v_target_id IS NULL)
           ) THEN
          RAISE EXCEPTION 'feeding schedule dispatch has invalid typed coordinates'
            USING ERRCODE = '22023';
        END IF;

        SELECT admission.* INTO STRICT v_admission
          FROM farm.feeding_catalog_admission admission
         WHERE admission.authority = 'feeding'
           AND admission."activeDigest" = p_envelope->>'catalogDigest'
           AND admission.generation
               = (p_envelope->>'catalogAdmissionGeneration')::bigint
         FOR SHARE;
        SELECT entry.* INTO STRICT v_catalog
          FROM farm.feeding_job_catalog_entries entry
          JOIN farm.feeding_catalog_revisions root
            ON root.digest = entry."catalogDigest"
         WHERE entry."catalogDigest" = v_admission."activeDigest"
           AND root.revision = p_envelope->>'catalogRevision'
           AND entry.id = p_envelope->>'jobId'
           AND entry.capability = 'scheduled.v2'
           AND entry.enabled = true
         FOR SHARE;
        SELECT root."canonicalJson"::jsonb->'dispatchRetryPolicy' INTO STRICT v_policy
          FROM farm.feeding_catalog_revisions root
         WHERE root.digest = v_catalog."catalogDigest";
        IF v_observed_at < v_now - pg_catalog.make_interval(
             secs => (v_policy->>'captureFreshnessSeconds')::integer
           )
           OR v_observed_at > v_now + pg_catalog.make_interval(
             secs => (v_policy->>'maxFutureSkewSeconds')::integer
           ) THEN
          RAISE EXCEPTION 'feeding schedule dispatch capture is outside catalog freshness'
            USING ERRCODE = '55000';
        END IF;
        SELECT authority.* INTO STRICT v_authority
          FROM farm.feeding_writer_authority authority
         WHERE authority."tenantId" = v_tenant_id
           AND authority.state = 'active'
           AND authority."catalogDigest" = v_admission."activeDigest"
           AND authority.generation = (p_envelope->>'authorityGeneration')::bigint
         FOR SHARE;

        IF v_catalog."timezoneSource" <> p_envelope->>'timezoneSource'
           OR (v_catalog."targetCardinality" = 'tenant' AND (
             p_envelope->>'targetKind' <> 'tenant'
             OR v_target_id IS NOT NULL
             OR p_envelope->>'timezone' <> 'UTC'
           ))
           OR (v_catalog."targetCardinality" = 'site' AND (
             p_envelope->>'targetKind' <> 'site' OR v_target_id IS NULL
           ))
           OR NOT farm.feeding_schedule_occurrence_matches(
             v_catalog.definition,
             v_observed_at,
             p_envelope->>'timezone',
             p_envelope->>'scheduleKey',
             v_due_at,
             v_local_date,
             (p_envelope->>'caughtUp')::boolean,
             (p_envelope->>'dstGapAdjusted')::boolean
           ) THEN
          RAISE EXCEPTION 'feeding schedule dispatch is not due under the admitted catalog'
            USING ERRCODE = '55000';
        END IF;

        SELECT count(*)::integer INTO v_cut_match_count
          FROM farm.compile_feeding_scheduler_cut(
            p_envelope->>'catalogRevision',
            p_envelope->>'catalogDigest',
            v_observed_at
          ) target
         WHERE target."rowKind" = 'task'
           AND target."catalogJob" = p_envelope->>'jobId'
           AND target."tenantId" = v_tenant_id
           AND target."targetKind" = p_envelope->>'targetKind'
           AND target."targetId" IS NOT DISTINCT FROM v_target_id
           AND target.timezone = p_envelope->>'timezone'
           AND target."authorityGeneration" = v_authority.generation
           AND target."catalogAdmissionGeneration" = v_admission.generation
           AND target."targetSetDigest" = p_envelope->>'targetSetDigest'
           AND target."cutDigest" = p_envelope->>'cutDigest';
        IF v_cut_match_count <> 1 THEN
          RAISE EXCEPTION 'feeding schedule dispatch is outside the exact scheduler cut'
            USING ERRCODE = '55000';
        END IF;

        v_expected_command_digest := pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            farm.canonical_feeding_json(pg_catalog.jsonb_build_object(
              'domain', 'aquaculture.feeding-operation-command',
              'schemaVersion', 'feeding-operation-command/v1',
              'value', CASE
                WHEN p_envelope->>'targetKind' = 'tenant' THEN pg_catalog.jsonb_build_object(
                  'jobId', p_envelope->>'jobId', 'tenantId', v_tenant_id
                )
                ELSE pg_catalog.jsonb_build_object(
                  'jobId', p_envelope->>'jobId', 'tenantId', v_tenant_id,
                  'siteId', v_target_id
                )
              END
            )), 'UTF8'
          )), 'hex'
        );
        v_expected_dispatch_digest := pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(
            farm.canonical_feeding_json(pg_catalog.jsonb_build_object(
              'domain', 'aquaculture.feeding-schedule-dispatch',
              'schemaVersion', 'feeding-schedule-dispatch/v1',
              'value', p_envelope - 'dispatchDigest'
            )), 'UTF8'
          )), 'hex'
        );
        IF p_envelope->>'commandDigest' <> v_expected_command_digest
           OR p_envelope->>'dispatchDigest' <> v_expected_dispatch_digest THEN
          RAISE EXCEPTION 'feeding schedule dispatch digest does not match canonical bytes'
            USING ERRCODE = '22023';
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          p_envelope->>'catalogDigest' || ':' ||
          (p_envelope->>'catalogAdmissionGeneration') || ':' ||
          (p_envelope->>'authorityGeneration') || ':' ||
          (p_envelope->>'jobId') || ':' || v_tenant_id::text || ':' ||
          (p_envelope->>'targetKind') || ':' || COALESCE(v_target_id::text, 'tenant') || ':' ||
          (p_envelope->>'scheduleKey'),
          0
        ));

        SELECT run.* INTO v_existing_run
          FROM farm.feeding_job_runs run
         WHERE run."tenantId" = v_tenant_id
           AND run."catalogJob" = p_envelope->>'jobId'
           AND run."targetKind" = p_envelope->>'targetKind'
           AND run."targetId" IS NOT DISTINCT FROM v_target_id
           AND run."scheduleKey" = p_envelope->>'scheduleKey'
           AND run.status IN ('leased', 'succeeded')
         FOR SHARE;
        IF FOUND THEN
          IF v_existing_run."catalogDigest" <> p_envelope->>'catalogDigest'
             OR v_existing_run.generation <> v_authority.generation
             OR v_existing_run."commandDigest" <> v_expected_command_digest THEN
            RAISE EXCEPTION 'feeding schedule business slot belongs to another authority epoch'
              USING ERRCODE = '23505';
          END IF;
          disposition := CASE
            WHEN v_existing_run.status = 'succeeded' THEN 'already_completed'
            ELSE 'already_running'
          END;
          "coordinateKind" := 'operation';
          "coordinateId" := v_existing_run."operationId";
          RETURN NEXT;
          RETURN;
        END IF;

        SELECT dispatch.* INTO v_existing
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE dispatch."catalogDigest" = p_envelope->>'catalogDigest'
           AND dispatch."catalogAdmissionGeneration" = v_admission.generation
           AND dispatch."authorityGeneration" = v_authority.generation
           AND dispatch."catalogJob" = p_envelope->>'jobId'
           AND dispatch."tenantId" = v_tenant_id
           AND dispatch."targetKind" = p_envelope->>'targetKind'
           AND dispatch."targetId" IS NOT DISTINCT FROM v_target_id
           AND dispatch."scheduleKey" = p_envelope->>'scheduleKey'
           AND dispatch.status IN ('pending', 'leased', 'completed', 'quarantined')
           AND farm.is_current_feeding_schedule_dispatch(dispatch.id)
         ORDER BY dispatch."enqueuedAt"
         LIMIT 1
         FOR UPDATE;
        IF FOUND THEN
          IF v_existing."commandDigest" <> v_expected_command_digest THEN
            RAISE EXCEPTION 'feeding schedule dispatch identity conflicts with command digest'
              USING ERRCODE = '23505';
          END IF;
          IF v_existing."schedulerCutDigest" = p_envelope->>'cutDigest'
             AND v_existing."dispatchDigest" <> v_expected_dispatch_digest THEN
            RAISE EXCEPTION 'feeding schedule dispatch cut conflicts with canonical payload'
              USING ERRCODE = '23505';
          END IF;
          disposition := CASE
            WHEN v_existing.status = 'quarantined' THEN 'quarantined'
            WHEN v_existing."schedulerCutDigest" = p_envelope->>'cutDigest'
              THEN 'idempotent'
            ELSE 'business_slot_preserved'
          END;
          "coordinateKind" := 'dispatch';
          "coordinateId" := v_existing.id;
          RETURN NEXT;
          RETURN;
        END IF;

        INSERT INTO farm.feeding_schedule_dispatches (
          "tenantId", "catalogJob", "targetKind", "targetId", "scheduleKey",
          "localDate", "observedAt", "dueAt", "caughtUp", "dstGapAdjusted",
          timezone, "timezoneSource", "catalogDigest", "catalogAdmissionGeneration",
          "authorityGeneration", "targetSetDigest", "schedulerCutDigest",
          "commandDigest", "dispatchDigest", "expiresAt", evidence
        ) VALUES (
          v_tenant_id, v_catalog.id, p_envelope->>'targetKind', v_target_id,
          p_envelope->>'scheduleKey', v_local_date, v_observed_at, v_due_at,
          (p_envelope->>'caughtUp')::boolean,
          (p_envelope->>'dstGapAdjusted')::boolean,
          p_envelope->>'timezone', v_catalog."timezoneSource", v_catalog."catalogDigest",
          v_admission.generation, v_authority.generation, p_envelope->>'targetSetDigest',
          p_envelope->>'cutDigest', v_expected_command_digest,
          v_expected_dispatch_digest,
          v_now + pg_catalog.make_interval(
            secs => (v_policy->>'terminalDeadlineSeconds')::integer
          ),
          p_envelope
        ) RETURNING * INTO STRICT v_dispatch;
        INSERT INTO farm.feeding_schedule_dispatch_transitions (
          "dispatchId", attempt, transition, evidence
        ) VALUES (
          v_dispatch.id, 0, 'enqueued', pg_catalog.jsonb_build_object(
            'schemaVersion', 'feeding-schedule-dispatch-transition/v1',
            'dispatchDigest', v_dispatch."dispatchDigest",
            'cutDigest', v_dispatch."schedulerCutDigest"
          )
        );
        disposition := 'enqueued';
        "coordinateKind" := 'dispatch';
        "coordinateId" := v_dispatch.id;
        RETURN NEXT;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding schedule dispatch authority is missing or stale'
            USING ERRCODE = '55000';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.claim_feeding_schedule_dispatch(
        p_worker_id varchar
      ) RETURNS TABLE (
        "dispatchId" uuid,
        "leaseToken" uuid,
        "leaseExpiresAt" timestamptz,
        envelope jsonb
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_stale record;
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_lease_token uuid := pg_catalog.gen_random_uuid();
        v_now timestamptz := pg_catalog.clock_timestamp();
      BEGIN
        IF p_worker_id !~ '^farm-service/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'feeding dispatch worker identity is invalid' USING ERRCODE = '22023';
        END IF;

        FOR v_stale IN
          SELECT dispatch.id, dispatch.attempt, dispatch."dispatchDigest",
                 eligibility.reason
            FROM farm.feeding_schedule_dispatches dispatch
            CROSS JOIN LATERAL (
              SELECT farm.feeding_schedule_dispatch_claimability(dispatch.id, v_now) AS reason
            ) eligibility
           WHERE (
             dispatch.status = 'pending'
             OR (dispatch.status = 'leased'
                 AND dispatch."leaseExpiresAt" <= v_now)
           )
             AND eligibility.reason <> 'claimable'
           ORDER BY dispatch."availableAt", dispatch."enqueuedAt"
           LIMIT 100
           FOR UPDATE SKIP LOCKED
        LOOP
          UPDATE farm.feeding_schedule_dispatches dispatch
             SET status = CASE
                   WHEN v_stale.reason = 'authority_stale' THEN 'rejected'
                   ELSE 'quarantined'
                 END,
                 "leaseToken" = NULL, "leaseExpiresAt" = NULL,
                 "completedAt" = v_now, "updatedAt" = v_now
           WHERE dispatch.id = v_stale.id;
          INSERT INTO farm.feeding_schedule_dispatch_transitions (
            "dispatchId", attempt, transition, evidence
          ) VALUES (
            v_stale.id, v_stale.attempt,
            CASE WHEN v_stale.reason = 'authority_stale'
              THEN 'rejected_stale' ELSE 'quarantined' END,
            pg_catalog.jsonb_build_object(
              'schemaVersion', 'feeding-schedule-dispatch-transition/v1',
              'workerId', p_worker_id,
              'dispatchDigest', v_stale."dispatchDigest",
              'reason', v_stale.reason
            )
          );
        END LOOP;

        SELECT dispatch.* INTO v_dispatch
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE (
           (dispatch.status = 'pending' AND dispatch."availableAt" <= v_now)
           OR (dispatch.status = 'leased'
               AND dispatch."leaseExpiresAt" <= v_now)
         )
           AND farm.feeding_schedule_dispatch_claimability(dispatch.id, v_now) = 'claimable'
         ORDER BY dispatch."dueAt", dispatch."availableAt", dispatch."enqueuedAt"
         LIMIT 1
         FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          RETURN;
        END IF;
        IF farm.feeding_schedule_dispatch_claimability(v_dispatch.id, v_now) <> 'claimable' THEN
          RAISE EXCEPTION 'feeding schedule dispatch became stale during claim'
            USING ERRCODE = '40001';
        END IF;

        UPDATE farm.feeding_schedule_dispatches dispatch
           SET status = 'leased', "leaseToken" = v_lease_token,
               "leaseExpiresAt" = LEAST(
                 v_now + INTERVAL '5 minutes', dispatch."expiresAt"
               ),
               attempt = dispatch.attempt + 1,
               "updatedAt" = v_now
         WHERE dispatch.id = v_dispatch.id
        RETURNING dispatch.* INTO STRICT v_dispatch;
        INSERT INTO farm.feeding_schedule_dispatch_transitions (
          "dispatchId", attempt, transition, evidence
        ) VALUES (
          v_dispatch.id, v_dispatch.attempt, 'lease_acquired',
          pg_catalog.jsonb_build_object(
            'schemaVersion', 'feeding-schedule-dispatch-transition/v1',
            'workerId', p_worker_id,
            'leaseToken', v_dispatch."leaseToken",
            'leaseExpiresAt', v_dispatch."leaseExpiresAt"
          )
        );
        "dispatchId" := v_dispatch.id;
        "leaseToken" := v_dispatch."leaseToken";
        "leaseExpiresAt" := v_dispatch."leaseExpiresAt";
        envelope := v_dispatch.evidence;
        RETURN NEXT;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.complete_feeding_schedule_dispatch(
        p_dispatch_id uuid,
        p_lease_token uuid,
        p_operation_id uuid
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_run_count integer;
      BEGIN
        SELECT dispatch.* INTO STRICT v_dispatch
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE dispatch.id = p_dispatch_id
         FOR UPDATE;
        IF v_dispatch.status <> 'leased'
           OR v_dispatch."leaseToken" <> p_lease_token
           OR v_dispatch."leaseExpiresAt" <= pg_catalog.clock_timestamp()
           OR v_dispatch."expiresAt" <= pg_catalog.clock_timestamp()
           OR NOT farm.is_current_feeding_schedule_dispatch(v_dispatch.id) THEN
          RAISE EXCEPTION 'feeding schedule dispatch completion lost its authority fence'
            USING ERRCODE = '40001';
        END IF;
        SELECT count(*)::integer INTO v_run_count
          FROM farm.feeding_job_runs run
         WHERE run."operationId" = p_operation_id
           AND run."tenantId" = v_dispatch."tenantId"
           AND run."catalogJob" = v_dispatch."catalogJob"
           AND run."targetKind" = v_dispatch."targetKind"
           AND run."targetId" IS NOT DISTINCT FROM v_dispatch."targetId"
           AND run."scheduleKey" = v_dispatch."scheduleKey"
           AND run."catalogDigest" = v_dispatch."catalogDigest"
           AND run.generation = v_dispatch."authorityGeneration"
           AND run."commandDigest" = v_dispatch."commandDigest"
           AND run."dueAt" = v_dispatch."dueAt"
           AND run."schedulerCutDigest" = v_dispatch."schedulerCutDigest"
           AND run.evidence->'intent'->>'dispatchDigest' = v_dispatch."dispatchDigest"
           AND run.status = 'succeeded';
        IF v_run_count <> 1 THEN
          RAISE EXCEPTION 'feeding schedule dispatch has no exact successful operation proof'
            USING ERRCODE = '55000';
        END IF;
        UPDATE farm.feeding_schedule_dispatches dispatch
           SET status = 'completed', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
               "operationId" = p_operation_id,
               "completedAt" = pg_catalog.clock_timestamp(),
               "updatedAt" = pg_catalog.clock_timestamp()
         WHERE dispatch.id = v_dispatch.id
           AND dispatch."leaseToken" = p_lease_token;
        INSERT INTO farm.feeding_schedule_dispatch_transitions (
          "dispatchId", attempt, transition, evidence
        ) VALUES (
          v_dispatch.id, v_dispatch.attempt, 'completed',
          pg_catalog.jsonb_build_object(
            'schemaVersion', 'feeding-schedule-dispatch-transition/v1',
            'operationId', p_operation_id,
            'commandDigest', v_dispatch."commandDigest"
          )
        );
        RETURN true;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding schedule dispatch does not exist' USING ERRCODE = '55000';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.release_feeding_schedule_dispatch(
        p_dispatch_id uuid,
        p_lease_token uuid,
        p_error_code varchar,
        p_error_digest varchar
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_dispatch farm.feeding_schedule_dispatches%ROWTYPE;
        v_policy jsonb;
        v_max_attempts integer;
        v_backoff_seconds integer;
        v_available_at timestamptz;
        v_terminal boolean;
        v_transition varchar;
        v_terminal_reason varchar;
        v_now timestamptz := pg_catalog.clock_timestamp();
      BEGIN
        IF p_error_code !~ '^FEEDING_[A-Z0-9_]{3,80}$'
           OR p_error_digest !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'feeding schedule dispatch failure evidence is invalid'
            USING ERRCODE = '22023';
        END IF;
        SELECT dispatch.* INTO STRICT v_dispatch
          FROM farm.feeding_schedule_dispatches dispatch
         WHERE dispatch.id = p_dispatch_id
         FOR UPDATE;
        IF v_dispatch.status <> 'leased' OR v_dispatch."leaseToken" <> p_lease_token THEN
          RAISE EXCEPTION 'feeding schedule dispatch release lost its lease fence'
            USING ERRCODE = '40001';
        END IF;
        SELECT root."canonicalJson"::jsonb->'dispatchRetryPolicy' INTO STRICT v_policy
          FROM farm.feeding_catalog_revisions root
         WHERE root.digest = v_dispatch."catalogDigest";
        v_max_attempts := (v_policy->>'maxAttempts')::integer;
        v_backoff_seconds := LEAST(
          (v_policy->>'maxBackoffSeconds')::integer,
          (
            (v_policy->>'baseBackoffSeconds')::numeric
            * pg_catalog.power(
                (v_policy->>'multiplier')::numeric,
                GREATEST(v_dispatch.attempt - 1, 0)
              )
          )::integer
        );
        v_available_at := v_now + pg_catalog.make_interval(secs => v_backoff_seconds);
        v_terminal := v_dispatch.attempt >= v_max_attempts
          OR v_available_at >= v_dispatch."expiresAt";
        v_terminal_reason := CASE
          WHEN v_dispatch.attempt >= v_max_attempts THEN 'attempts_exhausted'
          WHEN v_terminal THEN 'retry_deadline_elapsed'
          ELSE NULL
        END;
        v_transition := CASE WHEN v_terminal THEN 'quarantined' ELSE 'released' END;
        UPDATE farm.feeding_schedule_dispatches dispatch
           SET status = CASE WHEN v_terminal THEN 'quarantined' ELSE 'pending' END,
               "leaseToken" = NULL, "leaseExpiresAt" = NULL,
               "availableAt" = v_available_at,
               "completedAt" = CASE
                 WHEN v_terminal THEN v_now ELSE NULL
               END,
               "updatedAt" = v_now
         WHERE dispatch.id = v_dispatch.id
           AND dispatch."leaseToken" = p_lease_token;
        INSERT INTO farm.feeding_schedule_dispatch_transitions (
          "dispatchId", attempt, transition, evidence
        ) VALUES (
          v_dispatch.id, v_dispatch.attempt, v_transition,
          pg_catalog.jsonb_build_object(
            'schemaVersion', 'feeding-schedule-dispatch-transition/v1',
            'errorCode', p_error_code,
            'errorDigest', p_error_digest,
            'retryPolicySchemaVersion', v_policy->>'schemaVersion',
            'maxAttempts', v_max_attempts,
            'backoffSeconds', v_backoff_seconds,
            'nextAvailableAt', CASE
              WHEN v_terminal THEN NULL ELSE v_available_at
            END,
            'terminalReason', v_terminal_reason,
            'terminalDeadline', v_dispatch."expiresAt",
            'terminalDisposition', CASE
              WHEN v_terminal THEN v_policy->>'terminalDisposition' ELSE NULL
            END
          )
        );
        RETURN true;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'feeding schedule dispatch does not exist' USING ERRCODE = '55000';
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.record_feeding_scheduler_sweep(
        p_evidence jsonb
      ) RETURNS TABLE (
        generation bigint,
        status varchar,
        stage varchar,
        "recordedAt" timestamptz,
        "readyBacklogCount" bigint,
        "delayedBacklogCount" bigint,
        "leasedBacklogCount" bigint,
        "quarantinedCount" bigint,
        "rejectedCount" bigint,
        "oldestOutstandingDueAt" timestamptz
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_now timestamptz := pg_catalog.clock_timestamp();
        v_observed_at timestamptz;
        v_disposition_total bigint;
        v_failure_count integer;
        v_ready bigint;
        v_delayed bigint;
        v_leased bigint;
        v_quarantined bigint;
        v_rejected bigint;
        v_oldest timestamptz;
        v_heartbeat farm.feeding_scheduler_heartbeat%ROWTYPE;
      BEGIN
        IF p_evidence IS NULL
           OR pg_catalog.jsonb_typeof(p_evidence) <> 'object'
           OR NOT farm.jsonb_has_exact_keys(
             p_evidence,
             ARRAY[
               'schemaVersion', 'status', 'observedAt', 'stage', 'cutDigest',
               'dueCount', 'dispositions', 'failureDigests'
             ]
           )
           OR p_evidence->>'schemaVersion' <>
              '${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.schemaVersion}'
           OR p_evidence->>'status' NOT IN ('succeeded', 'failed')
           OR p_evidence->>'stage' NOT IN (
             'compile', 'dispatch_projection', 'enqueue', 'complete'
           )
           OR pg_catalog.jsonb_typeof(p_evidence->'dueCount') <> 'number'
           OR (p_evidence->'dueCount')::text !~ '^(0|[1-9][0-9]{0,9})$'
           OR pg_catalog.jsonb_typeof(p_evidence->'dispositions') <> 'object'
           OR NOT farm.jsonb_has_exact_keys(
             p_evidence->'dispositions',
             ARRAY[${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.dispositionKeys
               .map((key) => `'${key}'`)
               .join(', ')}]
           )
           OR EXISTS (
             SELECT 1
               FROM pg_catalog.jsonb_each(p_evidence->'dispositions') disposition
              WHERE pg_catalog.jsonb_typeof(disposition.value) <> 'number'
                 OR disposition.value::text !~ '^(0|[1-9][0-9]{0,9})$'
           )
           OR pg_catalog.jsonb_typeof(p_evidence->'failureDigests') <> 'array'
           OR EXISTS (
             SELECT 1
               FROM pg_catalog.jsonb_array_elements_text(
                 p_evidence->'failureDigests'
               ) failure(digest)
              WHERE failure.digest !~ '^[0-9a-f]{64}$'
           )
           OR (
             p_evidence->'cutDigest' <> 'null'::jsonb
             AND (
               pg_catalog.jsonb_typeof(p_evidence->'cutDigest') <> 'string'
               OR p_evidence->>'cutDigest' !~ '^[0-9a-f]{64}$'
             )
           ) THEN
          RAISE EXCEPTION 'feeding scheduler sweep evidence violates its closed contract'
            USING ERRCODE = '22023';
        END IF;

        v_observed_at := (p_evidence->>'observedAt')::timestamptz;
        IF p_evidence->>'observedAt' IS DISTINCT FROM pg_catalog.to_char(
             v_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ) THEN
          RAISE EXCEPTION 'feeding scheduler sweep observedAt is not canonical UTC'
            USING ERRCODE = '22023';
        END IF;

        SELECT COALESCE(pg_catalog.sum(disposition.value::text::bigint), 0)
          INTO v_disposition_total
          FROM pg_catalog.jsonb_each(p_evidence->'dispositions') disposition;
        v_failure_count := pg_catalog.jsonb_array_length(p_evidence->'failureDigests');
        IF (
             p_evidence->>'status' = 'succeeded'
             AND (
               p_evidence->>'stage' <> 'complete'
               OR v_failure_count <> 0
               OR v_disposition_total <> (p_evidence->>'dueCount')::bigint
             )
           ) OR (
             p_evidence->>'status' = 'failed'
             AND (
               p_evidence->>'stage' = 'complete'
               OR v_failure_count = 0
               OR (
                 p_evidence->>'stage' = 'enqueue'
                 AND v_disposition_total + v_failure_count <>
                     (p_evidence->>'dueCount')::bigint
               )
               OR (
                 p_evidence->>'stage' <> 'enqueue'
                 AND v_disposition_total <> 0
               )
             )
           ) THEN
          RAISE EXCEPTION 'feeding scheduler sweep totals contradict its terminal status'
            USING ERRCODE = '22023';
        END IF;

        SELECT
          count(*) FILTER (
            WHERE dispatch.status = 'pending' AND dispatch."availableAt" <= v_now
          )::bigint,
          count(*) FILTER (
            WHERE dispatch.status = 'pending' AND dispatch."availableAt" > v_now
          )::bigint,
          count(*) FILTER (WHERE dispatch.status = 'leased')::bigint,
          count(*) FILTER (WHERE dispatch.status = 'quarantined')::bigint,
          count(*) FILTER (WHERE dispatch.status = 'rejected')::bigint,
          min(dispatch."dueAt") FILTER (
            WHERE dispatch.status IN ('pending', 'leased')
          )
          INTO v_ready, v_delayed, v_leased, v_quarantined, v_rejected, v_oldest
          FROM farm.feeding_schedule_dispatches dispatch;

        INSERT INTO farm.feeding_scheduler_heartbeat (
          authority, generation, status, stage, "lastObservedAt", "lastAttemptAt",
          "lastSuccessAt", "lastFailureAt", "cutDigest", "dueCount",
          "dispositionCounts", "failureDigests", "readyBacklogCount",
          "delayedBacklogCount", "leasedBacklogCount", "quarantinedCount",
          "rejectedCount", "oldestOutstandingDueAt", evidence, "recordedAt"
        ) VALUES (
          '${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.authority}', 1,
          p_evidence->>'status', p_evidence->>'stage', v_observed_at, v_now,
          CASE WHEN p_evidence->>'status' = 'succeeded' THEN v_now ELSE NULL END,
          CASE WHEN p_evidence->>'status' = 'failed' THEN v_now ELSE NULL END,
          NULLIF(p_evidence->>'cutDigest', '')::char(64),
          (p_evidence->>'dueCount')::integer, p_evidence->'dispositions',
          p_evidence->'failureDigests', v_ready, v_delayed, v_leased,
          v_quarantined, v_rejected, v_oldest, p_evidence, v_now
        )
        ON CONFLICT (authority) DO UPDATE
          SET generation = farm.feeding_scheduler_heartbeat.generation + 1,
              status = EXCLUDED.status,
              stage = EXCLUDED.stage,
              "lastObservedAt" = EXCLUDED."lastObservedAt",
              "lastAttemptAt" = EXCLUDED."lastAttemptAt",
              "lastSuccessAt" = CASE
                WHEN EXCLUDED.status = 'succeeded' THEN EXCLUDED."lastAttemptAt"
                ELSE farm.feeding_scheduler_heartbeat."lastSuccessAt"
              END,
              "lastFailureAt" = CASE
                WHEN EXCLUDED.status = 'failed' THEN EXCLUDED."lastAttemptAt"
                ELSE farm.feeding_scheduler_heartbeat."lastFailureAt"
              END,
              "cutDigest" = EXCLUDED."cutDigest",
              "dueCount" = EXCLUDED."dueCount",
              "dispositionCounts" = EXCLUDED."dispositionCounts",
              "failureDigests" = EXCLUDED."failureDigests",
              "readyBacklogCount" = EXCLUDED."readyBacklogCount",
              "delayedBacklogCount" = EXCLUDED."delayedBacklogCount",
              "leasedBacklogCount" = EXCLUDED."leasedBacklogCount",
              "quarantinedCount" = EXCLUDED."quarantinedCount",
              "rejectedCount" = EXCLUDED."rejectedCount",
              "oldestOutstandingDueAt" = EXCLUDED."oldestOutstandingDueAt",
              evidence = EXCLUDED.evidence,
              "recordedAt" = EXCLUDED."recordedAt"
        RETURNING * INTO STRICT v_heartbeat;

        generation := v_heartbeat.generation;
        status := v_heartbeat.status;
        stage := v_heartbeat.stage;
        "recordedAt" := v_heartbeat."recordedAt";
        "readyBacklogCount" := v_heartbeat."readyBacklogCount";
        "delayedBacklogCount" := v_heartbeat."delayedBacklogCount";
        "leasedBacklogCount" := v_heartbeat."leasedBacklogCount";
        "quarantinedCount" := v_heartbeat."quarantinedCount";
        "rejectedCount" := v_heartbeat."rejectedCount";
        "oldestOutstandingDueAt" := v_heartbeat."oldestOutstandingDueAt";
        RETURN NEXT;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.read_feeding_scheduler_health(
        p_observed_at timestamptz
      ) RETURNS TABLE (
        healthy boolean,
        generation bigint,
        status varchar,
        stage varchar,
        "recordedAt" timestamptz,
        "heartbeatAgeSeconds" bigint,
        "readyBacklogCount" bigint,
        "delayedBacklogCount" bigint,
        "leasedBacklogCount" bigint,
        "quarantinedCount" bigint,
        "rejectedCount" bigint,
        "oldestOutstandingDueAt" timestamptz
      )
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_heartbeat farm.feeding_scheduler_heartbeat%ROWTYPE;
        v_age bigint;
      BEGIN
        SELECT heartbeat.* INTO v_heartbeat
          FROM farm.feeding_scheduler_heartbeat heartbeat
         WHERE heartbeat.authority =
               '${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.authority}';
        IF NOT FOUND THEN
          healthy := false;
          RETURN NEXT;
          RETURN;
        END IF;
        v_age := pg_catalog.floor(
          EXTRACT(EPOCH FROM (p_observed_at - v_heartbeat."recordedAt"))
        )::bigint;
        healthy := v_heartbeat.status = 'succeeded'
          AND v_age BETWEEN 0 AND
              ${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.maxHeartbeatAgeSeconds};
        generation := v_heartbeat.generation;
        status := v_heartbeat.status;
        stage := v_heartbeat.stage;
        "recordedAt" := v_heartbeat."recordedAt";
        "heartbeatAgeSeconds" := v_age;
        "readyBacklogCount" := v_heartbeat."readyBacklogCount";
        "delayedBacklogCount" := v_heartbeat."delayedBacklogCount";
        "leasedBacklogCount" := v_heartbeat."leasedBacklogCount";
        "quarantinedCount" := v_heartbeat."quarantinedCount";
        "rejectedCount" := v_heartbeat."rejectedCount";
        "oldestOutstandingDueAt" := v_heartbeat."oldestOutstandingDueAt";
        RETURN NEXT;
      END;
      $body$
    `);

    for (const relation of FEEDING_CONTROL_PLANE_RELATIONS) {
      await queryRunner.query(`REVOKE ALL ON ${relation.name} FROM ${FEEDING_RUNTIME_ROLE}`);
      await queryRunner.query(`REVOKE ALL ON ${relation.name} FROM ${FEEDING_SCHEDULER_ROLE}`);
      await queryRunner.query(`REVOKE ALL ON ${relation.name} FROM ${FEEDING_MIGRATION_ROLE}`);
    }
    for (const authority of FEEDING_MIGRATION_RELATION_PRIVILEGES) {
      await queryRunner.query(
        `GRANT ${authority.privileges} ON ${authority.name} TO ${FEEDING_MIGRATION_ROLE}`,
      );
    }
    await queryRunner.query(`GRANT USAGE ON SCHEMA farm TO ${FEEDING_MIGRATION_ROLE}`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA farm TO ${FEEDING_SCHEDULER_ROLE}`);

    for (const signature of FEEDING_CONTROL_PLANE_KERNEL_FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${FEEDING_RUNTIME_ROLE}`);
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${FEEDING_SCHEDULER_ROLE}`);
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${FEEDING_MIGRATION_ROLE}`);
      await queryRunner.query(
        `ALTER FUNCTION ${signature} OWNER TO ${FEEDING_DATABASE_OWNER_ROLE}`,
      );
    }
    await queryRunner.query(`GRANT USAGE ON SCHEMA platform TO ${FEEDING_DATABASE_OWNER_ROLE}`);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${FEEDING_DATABASE_OWNER_ROLE}`,
    );
    for (const signature of FEEDING_TENANT_RUNTIME_KERNEL_FUNCTIONS) {
      await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${FEEDING_RUNTIME_ROLE}`);
    }
    for (const signature of FEEDING_SCHEDULER_KERNEL_FUNCTIONS) {
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${FEEDING_SCHEDULER_ROLE}`,
      );
    }
    for (const signature of FEEDING_MIGRATION_KERNEL_FUNCTIONS) {
      await queryRunner.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${FEEDING_MIGRATION_ROLE}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.read_feeding_scheduler_health(timestamptz)`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.record_feeding_scheduler_sweep(jsonb)`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.release_feeding_schedule_dispatch(uuid,uuid,varchar,varchar)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.complete_feeding_schedule_dispatch(uuid,uuid,uuid)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.claim_feeding_schedule_dispatch(varchar)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.enqueue_feeding_schedule_dispatch(jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.is_current_feeding_schedule_dispatch(uuid)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.compile_feeding_scheduler_cut(varchar,varchar,timestamptz)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.compile_feeding_job_targets(varchar,varchar,varchar,timestamptz)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.fail_feeding_job(uuid,uuid,varchar,varchar,jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.complete_feeding_job(uuid,uuid,varchar,varchar,varchar,text,varchar,jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.claim_feeding_job(uuid,varchar,varchar,date,varchar,varchar,varchar,varchar,uuid,varchar,varchar,varchar,bigint,bigint,varchar,jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.feeding_schedule_occurrence_matches(jsonb,timestamptz,varchar,varchar,timestamptz,date,boolean,boolean)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.admit_feeding_catalog(bigint,varchar,varchar,varchar,jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.transition_feeding_writer_authority(uuid,bigint,varchar,varchar,varchar,varchar,varchar,jsonb)`,
    );
  }
}

bindFeedingMigrationExecutionScopeV1(
  InstallFeedingOperationMutationKernel1808700000000,
  FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations.installMutationKernel,
);
