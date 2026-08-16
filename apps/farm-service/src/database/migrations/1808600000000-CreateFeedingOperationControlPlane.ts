import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
  bindFeedingMigrationExecutionScopeV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
const FEEDING_RESULT_HASH_DOMAIN_V1 = FEEDING_MIGRATION_AUTHORITY_V1.resultArtifact.hashDomain;
const FEEDING_RESULT_HASH_SCHEMA_VERSION_V1 =
  FEEDING_MIGRATION_AUTHORITY_V1.resultArtifact.hashSchemaVersion;
const FEEDING_RESULT_PORTABILITY_V1 = FEEDING_MIGRATION_AUTHORITY_V1.resultArtifact.portability;
const FEEDING_CONTROL_PLANE_HELPER_FUNCTIONS =
  FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.helperFunctions;
const FEEDING_CONTROL_PLANE_RELATIONS = FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.relations;
const FEEDING_CONTROL_PLANE_SEQUENCES = FEEDING_MIGRATION_AUTHORITY_V1.controlPlane.sequences;
const FEEDING_DATABASE_OWNER_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.databaseOwner;
const FEEDING_RUNTIME_ROLE = FEEDING_MIGRATION_AUTHORITY_V1.roles.runtime;

/**
 * Creates the source-only feeding operation control plane.
 *
 * Catalog releases are content-addressed, append-only artifacts. The mutable
 * `feeding_catalog_admission` row is only a CAS pointer; it never replaces the
 * historical root or entries that an operation run references.
 */
export class CreateFeedingOperationControlPlane1808600000000 implements MigrationInterface {
  name = 'CreateFeedingOperationControlPlane1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.jsonb_has_exact_keys(
        p_value jsonb,
        p_keys text[]
      ) RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
        SELECT pg_catalog.jsonb_typeof(p_value) = 'object'
          AND (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_value))
              = pg_catalog.cardinality(p_keys)
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.jsonb_object_keys(p_value) AS actual(key)
             WHERE NOT (actual.key = ANY(p_keys))
          )
      $body$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.is_valid_feeding_catalog_job(p_job jsonb)
      RETURNS boolean
      LANGUAGE plpgsql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_kind text := p_job->>'scheduleKind';
        v_capability text := p_job->>'capability';
        v_misfire jsonb := p_job->'misfire';
        v_base_keys text[] := ARRAY[
          'id', 'capability', 'scheduleKind', 'clockProfile', 'targetCardinality',
          'timezoneSource', 'misfire', 'leaseSeconds', 'enabled'
        ];
        v_numeric numeric;
      BEGIN
        IF pg_catalog.jsonb_typeof(p_job) <> 'object'
           OR pg_catalog.length(p_job->>'id') NOT BETWEEN 5 AND 160
           OR p_job->>'id' !~ '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*){2,5}$'
           OR pg_catalog.jsonb_typeof(p_job->'enabled') <> 'boolean'
           OR pg_catalog.jsonb_typeof(p_job->'leaseSeconds') <> 'number' THEN
          RETURN false;
        END IF;
        v_numeric := (p_job->>'leaseSeconds')::numeric;
        IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric NOT BETWEEN 1 AND 86400 THEN
          RETURN false;
        END IF;

        IF v_kind = 'on_demand' THEN
          RETURN farm.jsonb_has_exact_keys(p_job, v_base_keys)
            AND v_capability IN ('operator.manual', 'device.mobile')
            AND p_job->>'clockProfile' = 'site_local'
            AND p_job->>'targetCardinality' = 'operation_target'
            AND p_job->>'timezoneSource' = 'tenant_site_catalog'
            AND v_misfire = 'null'::jsonb;
        END IF;

        IF v_capability <> 'scheduled.v2'
           OR v_kind NOT IN ('local_daily', 'local_weekly', 'local_monthly', 'absolute_interval')
           OR pg_catalog.jsonb_typeof(v_misfire) <> 'object'
           OR NOT farm.jsonb_has_exact_keys(
             v_misfire,
             ARRAY['mode', 'catchUpWindowMinutes', 'dstGap', 'dstFold']
           )
           OR v_misfire->>'mode' <> 'catch_up'
           OR v_misfire->>'dstGap' <> 'next_valid_instant'
           OR v_misfire->>'dstFold' <> 'single_semantic_occurrence'
           OR pg_catalog.jsonb_typeof(v_misfire->'catchUpWindowMinutes') <> 'number' THEN
          RETURN false;
        END IF;
        v_numeric := (v_misfire->>'catchUpWindowMinutes')::numeric;
        IF v_numeric <> pg_catalog.trunc(v_numeric) OR v_numeric NOT BETWEEN 1 AND 10080 THEN
          RETURN false;
        END IF;
        IF NOT (
          (p_job->>'clockProfile' = 'site_local'
           AND p_job->>'targetCardinality' = 'site'
           AND p_job->>'timezoneSource' = 'tenant_site_catalog')
          OR
          (p_job->>'clockProfile' = 'utc_global'
           AND p_job->>'targetCardinality' = 'tenant'
           AND p_job->>'timezoneSource' = 'utc_global')
        ) THEN
          RETURN false;
        END IF;

        IF v_kind = 'absolute_interval' THEN
          IF NOT farm.jsonb_has_exact_keys(p_job, v_base_keys || ARRAY['intervalMinutes'])
             OR pg_catalog.jsonb_typeof(p_job->'intervalMinutes') <> 'number' THEN
            RETURN false;
          END IF;
          v_numeric := (p_job->>'intervalMinutes')::numeric;
          RETURN v_numeric = pg_catalog.trunc(v_numeric) AND v_numeric BETWEEN 1 AND 10080;
        END IF;
        IF p_job->>'localTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
          RETURN false;
        END IF;
        IF v_kind = 'local_daily' THEN
          RETURN farm.jsonb_has_exact_keys(p_job, v_base_keys || ARRAY['localTime']);
        END IF;
        IF v_kind = 'local_weekly' THEN
          IF NOT farm.jsonb_has_exact_keys(p_job, v_base_keys || ARRAY['localTime','localWeekday'])
             OR pg_catalog.jsonb_typeof(p_job->'localWeekday') <> 'number' THEN
            RETURN false;
          END IF;
          v_numeric := (p_job->>'localWeekday')::numeric;
          RETURN v_numeric = pg_catalog.trunc(v_numeric) AND v_numeric BETWEEN 1 AND 7;
        END IF;
        IF NOT farm.jsonb_has_exact_keys(p_job, v_base_keys || ARRAY['localTime','localDayOfMonth'])
           OR pg_catalog.jsonb_typeof(p_job->'localDayOfMonth') <> 'number' THEN
          RETURN false;
        END IF;
        v_numeric := (p_job->>'localDayOfMonth')::numeric;
        RETURN v_numeric = pg_catalog.trunc(v_numeric) AND v_numeric BETWEEN 1 AND 31;
      EXCEPTION WHEN OTHERS THEN
        RETURN false;
      END;
      $body$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.canonical_feeding_json(p_value jsonb)
      RETURNS text
      LANGUAGE plpgsql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_type text := pg_catalog.jsonb_typeof(p_value);
        v_result text;
      BEGIN
        IF v_type = 'object' THEN
          SELECT '{' || COALESCE(
            pg_catalog.string_agg(
              pg_catalog.to_jsonb(member.key)::text || ':' || farm.canonical_feeding_json(member.value),
              ',' ORDER BY member.key COLLATE "C"
            ),
            ''
          ) || '}'
            INTO v_result
            FROM pg_catalog.jsonb_each(p_value) AS member(key, value);
          RETURN v_result;
        END IF;
        IF v_type = 'array' THEN
          SELECT '[' || COALESCE(
            pg_catalog.string_agg(
              farm.canonical_feeding_json(element.value),
              ',' ORDER BY element.ordinality
            ),
            ''
          ) || ']'
            INTO v_result
            FROM pg_catalog.jsonb_array_elements(p_value)
              WITH ORDINALITY AS element(value, ordinality);
          RETURN v_result;
        END IF;
        IF v_type = 'number' THEN
          IF (p_value #>> '{}')::numeric = 0 THEN
            RETURN '0';
          END IF;
          v_result := p_value::text;
          IF pg_catalog.strpos(v_result, '.') > 0 THEN
            WHILE pg_catalog.right(v_result, 1) = '0' LOOP
              v_result := pg_catalog.left(v_result, pg_catalog.length(v_result) - 1);
            END LOOP;
            IF pg_catalog.right(v_result, 1) = '.' THEN
              v_result := pg_catalog.left(v_result, pg_catalog.length(v_result) - 1);
            END IF;
          END IF;
          RETURN v_result;
        END IF;
        RETURN p_value::text;
      END;
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.is_valid_feeding_result_payload(p_value jsonb)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
        WITH RECURSIVE payload_nodes(value, depth, key_is_portable) AS (
          VALUES (p_value, 0, true)
          UNION ALL
          SELECT child.value,
                 parent.depth + 1,
                 child.object_key IS NULL
                   OR child.object_key COLLATE "C"
                        ~ '${FEEDING_RESULT_PORTABILITY_V1.objectKeyPattern}'
            FROM payload_nodes parent
            CROSS JOIN LATERAL (
              SELECT NULL::text AS object_key, element.value
                FROM pg_catalog.jsonb_array_elements(
                  CASE WHEN pg_catalog.jsonb_typeof(parent.value) = 'array'
                    THEN parent.value ELSE '[]'::jsonb END
                ) AS element(value)
              UNION ALL
              SELECT member.key AS object_key, member.value
                FROM pg_catalog.jsonb_each(
                  CASE WHEN pg_catalog.jsonb_typeof(parent.value) = 'object'
                    THEN parent.value ELSE '{}'::jsonb END
                ) AS member(key, value)
            ) child
           -- Materialize the first invalid layer so depth=max+1 is observable,
           -- then stop recursion before an adversarial document can exhaust the stack.
           WHERE parent.depth <= ${FEEDING_RESULT_PORTABILITY_V1.maxDepth}
        )
        SELECT NOT EXISTS (
          SELECT 1
            FROM payload_nodes node
           WHERE node.depth > ${FEEDING_RESULT_PORTABILITY_V1.maxDepth}
              OR NOT node.key_is_portable
              OR pg_catalog.jsonb_typeof(node.value) NOT IN (
                'null', 'boolean', 'string', 'number', 'array', 'object'
              )
              OR (
                pg_catalog.jsonb_typeof(node.value) = 'number'
                AND NOT (
                  (
                    (node.value #>> '{}')::numeric
                      = pg_catalog.trunc((node.value #>> '{}')::numeric)
                    AND pg_catalog.abs((node.value #>> '{}')::numeric)
                      <= ${FEEDING_RESULT_PORTABILITY_V1.maxSafeInteger}::numeric
                  )
                  OR (
                    (node.value #>> '{}')::numeric
                      <> pg_catalog.trunc((node.value #>> '{}')::numeric)
                    AND pg_catalog.abs((node.value #>> '{}')::numeric)
                      BETWEEN ${FEEDING_RESULT_PORTABILITY_V1.minNonZeroNumber}::numeric
                          AND ${FEEDING_RESULT_PORTABILITY_V1.maxSafeInteger}::numeric
                  )
                )
              )
        )
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.feeding_result_hash_preimage(
        p_result_schema varchar,
        p_result_payload text
      ) RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
        SELECT
          '{"domain":"${FEEDING_RESULT_HASH_DOMAIN_V1}","schemaVersion":"${FEEDING_RESULT_HASH_SCHEMA_VERSION_V1}","value":{"payload":'
          || p_result_payload
          || ',"resultSchema":'
          || pg_catalog.to_jsonb(p_result_schema)::text
          || '}}'
      $body$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.feeding_result_digest(
        p_result_schema varchar,
        p_result_payload text
      ) RETURNS varchar
      LANGUAGE sql
      IMMUTABLE
      STRICT
      SET search_path = pg_catalog, pg_temp
      AS $body$
        SELECT pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              farm.feeding_result_hash_preimage(p_result_schema, p_result_payload),
              'UTF8'
            )
          ),
          'hex'
        )::varchar
      $body$
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_catalog_revisions (
        digest char(64) PRIMARY KEY,
        revision varchar(80) NOT NULL,
        "canonicalJson" text NOT NULL,
        "jobCount" integer NOT NULL CHECK ("jobCount" > 0),
        "projectedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_feeding_catalog_root_digest"
          CHECK (
            digest = pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(
                '{"domain":"aquaculture.feeding-job-catalog","schemaVersion":' ||
                pg_catalog.to_jsonb(revision)::text || ',"value":' || "canonicalJson" || '}',
                'UTF8'
              )),
              'hex'
            )
          ),
        CONSTRAINT "CHK_feeding_catalog_root_shape"
          CHECK (
            pg_catalog.jsonb_typeof("canonicalJson"::jsonb) = 'object'
            AND farm.jsonb_has_exact_keys(
              "canonicalJson"::jsonb,
              ARRAY['revision','dispatchRetryPolicy','scheduleExecutionPolicy','jobs']
            )
            AND farm.jsonb_has_exact_keys(
              "canonicalJson"::jsonb->'dispatchRetryPolicy',
              ARRAY[
                'schemaVersion', 'maxAttempts', 'baseBackoffSeconds',
                'maxBackoffSeconds', 'multiplier', 'captureFreshnessSeconds',
                'maxFutureSkewSeconds', 'terminalDeadlineSeconds',
                'terminalDisposition'
              ]
            )
            AND "canonicalJson"::jsonb->'dispatchRetryPolicy'->>'schemaVersion'
                = 'feeding-schedule-dispatch-retry/v1'
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'maxAttempts')::integer
                BETWEEN 1 AND 100
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'baseBackoffSeconds')::integer
                BETWEEN 1 AND 3600
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'maxBackoffSeconds')::integer
                BETWEEN ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'baseBackoffSeconds')::integer
                    AND 86400
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'multiplier')::integer
                BETWEEN 1 AND 10
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'captureFreshnessSeconds')::integer
                BETWEEN 1 AND 3600
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'maxFutureSkewSeconds')::integer
                BETWEEN 0 AND 3600
            AND ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'terminalDeadlineSeconds')::integer
                BETWEEN ("canonicalJson"::jsonb->'dispatchRetryPolicy'->>'maxBackoffSeconds')::integer
                    AND 604800
            AND "canonicalJson"::jsonb->'dispatchRetryPolicy'->>'terminalDisposition'
                = 'quarantined'
            AND farm.jsonb_has_exact_keys(
              "canonicalJson"::jsonb->'scheduleExecutionPolicy',
              ARRAY[
                'schemaVersion', 'mealOverdueGraceMinutes', 'mealClaimPageSize',
                'fcrWarningVariancePercent', 'fcrCriticalVariancePercent'
              ]
            )
            AND "canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'schemaVersion'
                = 'feeding-schedule-execution-policy/v1'
            AND ("canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'mealOverdueGraceMinutes')::integer
                BETWEEN 1 AND 1440
            AND ("canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'mealClaimPageSize')::integer
                BETWEEN 1 AND 10000
            AND ("canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'fcrWarningVariancePercent')::integer
                BETWEEN 1 AND 99
            AND ("canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'fcrCriticalVariancePercent')::integer
                BETWEEN (
                  "canonicalJson"::jsonb->'scheduleExecutionPolicy'->>'fcrWarningVariancePercent'
                )::integer AND 100
            AND pg_catalog.jsonb_typeof("canonicalJson"::jsonb->'jobs') = 'array'
            AND revision = "canonicalJson"::jsonb->>'revision'
            AND pg_catalog.length(revision) BETWEEN 22 AND 80
            AND revision ~ '^feeding-job-catalog/v[1-9][0-9]{0,8}$'
            AND "jobCount" = pg_catalog.jsonb_array_length("canonicalJson"::jsonb->'jobs')
            AND "canonicalJson" = farm.canonical_feeding_json("canonicalJson"::jsonb)
          )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_job_catalog_entries (
        "catalogDigest" char(64) NOT NULL,
        id varchar(160) NOT NULL,
        capability varchar(32) NOT NULL,
        "scheduleKind" varchar(32) NOT NULL,
        "clockProfile" varchar(32) NOT NULL,
        "targetCardinality" varchar(32) NOT NULL,
        "timezoneSource" varchar(32) NOT NULL,
        "leaseSeconds" integer NOT NULL CHECK ("leaseSeconds" BETWEEN 1 AND 86400),
        enabled boolean NOT NULL,
        definition jsonb NOT NULL,
        PRIMARY KEY ("catalogDigest", id),
        CONSTRAINT "FK_feeding_catalog_entry_root"
          FOREIGN KEY ("catalogDigest") REFERENCES farm.feeding_catalog_revisions(digest),
        CONSTRAINT "CHK_feeding_catalog_entry_capability"
          CHECK (capability IN ('scheduled.v2', 'operator.manual', 'device.mobile')),
        CONSTRAINT "CHK_feeding_catalog_entry_schedule_kind"
          CHECK ("scheduleKind" IN (
            'local_daily', 'local_weekly', 'local_monthly', 'absolute_interval', 'on_demand'
          )),
        CONSTRAINT "CHK_feeding_catalog_entry_timezone_source"
          CHECK ("timezoneSource" IN ('tenant_site_catalog', 'utc_global')),
        CONSTRAINT "CHK_feeding_catalog_entry_clock_profile"
          CHECK ("clockProfile" IN ('site_local', 'utc_global')),
        CONSTRAINT "CHK_feeding_catalog_entry_target_cardinality"
          CHECK ("targetCardinality" IN ('site', 'tenant', 'operation_target'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_catalog_admission (
        authority varchar(32) PRIMARY KEY,
        generation bigint NOT NULL CHECK (generation > 0),
        "activeDigest" char(64) NOT NULL,
        "admittedBy" varchar(160) NOT NULL,
        evidence jsonb NOT NULL,
        "admittedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_feeding_catalog_admission_authority" CHECK (authority = 'feeding'),
        CONSTRAINT "FK_feeding_catalog_admission_root"
          FOREIGN KEY ("activeDigest") REFERENCES farm.feeding_catalog_revisions(digest)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_catalog_admission_history (
        generation bigint PRIMARY KEY CHECK (generation > 0),
        "catalogDigest" char(64) NOT NULL,
        "admittedBy" varchar(160) NOT NULL,
        evidence jsonb NOT NULL,
        "admittedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_catalog_admission_history_root"
          FOREIGN KEY ("catalogDigest") REFERENCES farm.feeding_catalog_revisions(digest)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_writer_authority (
        "tenantId" uuid PRIMARY KEY,
        generation bigint NOT NULL CHECK (generation > 0),
        state varchar(16) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "activatedBy" varchar(160) NOT NULL,
        "activatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        evidence jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_writer_authority_catalog_root"
          FOREIGN KEY ("catalogDigest") REFERENCES farm.feeding_catalog_revisions(digest),
        CONSTRAINT "CHK_feeding_writer_authority_state"
          CHECK (state IN ('active', 'revoked'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE farm.feeding_writer_authority_history (
        "tenantId" uuid NOT NULL,
        generation bigint NOT NULL CHECK (generation > 0),
        state varchar(16) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        transition varchar(16) NOT NULL,
        "changedBy" varchar(160) NOT NULL,
        evidence jsonb NOT NULL,
        "transitionedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY ("tenantId", generation),
        CONSTRAINT "FK_feeding_writer_authority_history_root"
          FOREIGN KEY ("catalogDigest") REFERENCES farm.feeding_catalog_revisions(digest),
        CONSTRAINT "CHK_feeding_writer_authority_history_state"
          CHECK (state IN ('active', 'revoked')),
        CONSTRAINT "CHK_feeding_writer_authority_history_transition"
          CHECK (
            (state = 'active' AND transition = 'activated')
            OR (state = 'revoked' AND transition = 'revoked')
          )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_schedule_dispatches (
        id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "catalogJob" varchar(160) NOT NULL,
        "targetKind" varchar(16) NOT NULL,
        "targetId" uuid,
        "scheduleKey" varchar(200) NOT NULL,
        "localDate" date NOT NULL,
        "observedAt" timestamptz NOT NULL,
        "dueAt" timestamptz NOT NULL,
        "caughtUp" boolean NOT NULL,
        "dstGapAdjusted" boolean NOT NULL,
        timezone varchar(64) NOT NULL,
        "timezoneSource" varchar(32) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "catalogAdmissionGeneration" bigint NOT NULL CHECK ("catalogAdmissionGeneration" > 0),
        "authorityGeneration" bigint NOT NULL CHECK ("authorityGeneration" > 0),
        "targetSetDigest" char(64) NOT NULL,
        "schedulerCutDigest" char(64) NOT NULL,
        "commandDigest" char(64) NOT NULL,
        "dispatchDigest" char(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'pending',
        "leaseToken" uuid,
        "leaseExpiresAt" timestamptz,
        attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        "availableAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "expiresAt" timestamptz NOT NULL,
        "operationId" uuid,
        evidence jsonb NOT NULL,
        "enqueuedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "completedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_schedule_dispatch_catalog_entry"
          FOREIGN KEY ("catalogDigest", "catalogJob")
          REFERENCES farm.feeding_job_catalog_entries("catalogDigest", id),
        CONSTRAINT "CHK_feeding_schedule_dispatch_status"
          CHECK (status IN ('pending', 'leased', 'completed', 'rejected', 'quarantined')),
        CONSTRAINT "CHK_feeding_schedule_dispatch_target"
          CHECK (
            ("targetKind" = 'tenant' AND "targetId" IS NULL)
            OR ("targetKind" = 'site' AND "targetId" IS NOT NULL)
          ),
        CONSTRAINT "CHK_feeding_schedule_dispatch_digests"
          CHECK (
            "targetSetDigest" ~ '^[0-9a-f]{64}$'
            AND "schedulerCutDigest" ~ '^[0-9a-f]{64}$'
            AND "commandDigest" ~ '^[0-9a-f]{64}$'
            AND "dispatchDigest" ~ '^[0-9a-f]{64}$'
          ),
        CONSTRAINT "CHK_feeding_schedule_dispatch_deadline"
          CHECK ("expiresAt" > "enqueuedAt"),
        CONSTRAINT "CHK_feeding_schedule_dispatch_lease"
          CHECK (
            (status = 'pending' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
            OR (status = 'leased' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
            OR (
              status = 'completed' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
              AND "operationId" IS NOT NULL AND "completedAt" IS NOT NULL
            )
            OR (
              status = 'rejected' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
              AND "operationId" IS NULL AND "completedAt" IS NOT NULL
            )
            OR (
              status = 'quarantined' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
              AND "operationId" IS NULL AND "completedAt" IS NOT NULL
            )
          )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_feeding_schedule_dispatch_authority_cut"
        ON farm.feeding_schedule_dispatches (
          "catalogDigest", "catalogAdmissionGeneration", "authorityGeneration",
          "catalogJob", "tenantId", "targetKind", "targetId", "scheduleKey",
          "schedulerCutDigest"
        ) NULLS NOT DISTINCT
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_feeding_schedule_dispatch_claimable"
        ON farm.feeding_schedule_dispatches ("dueAt", "availableAt", "expiresAt", "enqueuedAt")
        WHERE status = 'pending' OR status = 'leased'
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_schedule_dispatch_transitions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "dispatchId" uuid NOT NULL,
        attempt integer NOT NULL CHECK (attempt >= 0),
        transition varchar(32) NOT NULL,
        evidence jsonb NOT NULL,
        "transitionedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_schedule_dispatch_transition"
          FOREIGN KEY ("dispatchId") REFERENCES farm.feeding_schedule_dispatches(id),
        CONSTRAINT "CHK_feeding_schedule_dispatch_transition"
          CHECK (
            transition IN (
              'enqueued', 'lease_acquired', 'released', 'completed', 'rejected_stale',
              'quarantined'
            )
          ),
        CONSTRAINT "UQ_feeding_schedule_dispatch_transition_state"
          UNIQUE ("dispatchId", attempt, transition)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_job_runs (
        id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        generation bigint NOT NULL CHECK (generation > 0),
        capability varchar(32) NOT NULL,
        "catalogJob" varchar(160) NOT NULL,
        "scheduleKind" varchar(32) NOT NULL,
        "clockProfile" varchar(32) NOT NULL,
        "targetKind" varchar(16) NOT NULL,
        "targetId" uuid,
        "scheduleKey" varchar(200) NOT NULL,
        "localDate" date NOT NULL,
        "observedAt" timestamptz NOT NULL,
        "dueAt" timestamptz NOT NULL,
        "caughtUp" boolean NOT NULL,
        "dstGapAdjusted" boolean NOT NULL,
        timezone varchar(64) NOT NULL,
        "timezoneSource" varchar(32) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "catalogAdmissionGeneration" bigint,
        "authorityGeneration" bigint,
        "targetSetDigest" char(64),
        "schedulerCutDigest" char(64),
        "commandDigest" char(64) NOT NULL,
        "operationId" uuid NOT NULL UNIQUE,
        "leaseToken" uuid NOT NULL,
        "leaseExpiresAt" timestamptz NOT NULL,
        attempt integer NOT NULL CHECK (attempt > 0),
        status varchar(16) NOT NULL,
        evidence jsonb NOT NULL,
        "resultSchema" varchar(200),
        "resultPayload" text,
        "resultDigest" char(64),
        "startedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        "completedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_job_run_catalog_entry"
          FOREIGN KEY ("catalogDigest", "catalogJob")
          REFERENCES farm.feeding_job_catalog_entries("catalogDigest", id),
        CONSTRAINT "CHK_feeding_job_runs_status"
          CHECK (status IN ('leased', 'succeeded', 'failed')),
        CONSTRAINT "CHK_feeding_job_runs_capability"
          CHECK (capability IN ('scheduled.v2', 'operator.manual', 'device.mobile')),
        CONSTRAINT "CHK_feeding_job_runs_timezone_source"
          CHECK ("timezoneSource" IN ('tenant_site_catalog', 'utc_global')),
        CONSTRAINT "CHK_feeding_job_runs_clock_profile"
          CHECK ("clockProfile" IN ('site_local', 'utc_global')),
        CONSTRAINT "CHK_feeding_job_runs_command_digest"
          CHECK ("commandDigest" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_feeding_job_runs_scheduler_cut"
          CHECK (
            (
              capability = 'scheduled.v2'
              AND "catalogAdmissionGeneration" > 0
              AND "authorityGeneration" > 0
              AND "targetSetDigest" ~ '^[0-9a-f]{64}$'
              AND "schedulerCutDigest" ~ '^[0-9a-f]{64}$'
            )
            OR (
              capability <> 'scheduled.v2'
              AND "catalogAdmissionGeneration" IS NULL
              AND "authorityGeneration" IS NULL
              AND "targetSetDigest" IS NULL
              AND "schedulerCutDigest" IS NULL
              AND "caughtUp" = false
              AND "dstGapAdjusted" = false
            )
          ),
        CONSTRAINT "CHK_feeding_job_runs_terminal_result"
          CHECK (
            (
              status = 'succeeded'
              AND "resultSchema" IS NOT NULL
              AND pg_catalog.length("resultSchema") BETWEEN 1 AND 200
              AND "resultPayload" IS NOT NULL
              AND pg_catalog.octet_length("resultPayload")
                    BETWEEN 2 AND ${FEEDING_RESULT_PORTABILITY_V1.maxPayloadBytes}
              AND "resultPayload"::jsonb IS NOT NULL
              AND farm.is_valid_feeding_result_payload("resultPayload"::jsonb)
              AND "resultPayload" = farm.canonical_feeding_json("resultPayload"::jsonb)
              AND "resultDigest" = farm.feeding_result_digest(
                "resultSchema",
                "resultPayload"
              )
            )
            OR (
              status <> 'succeeded'
              AND "resultSchema" IS NULL
              AND "resultPayload" IS NULL
              AND "resultDigest" IS NULL
            )
          ),
        CONSTRAINT "CHK_feeding_job_runs_target"
          CHECK (
            ("targetKind" = 'tenant' AND "targetId" IS NULL)
            OR ("targetKind" IN ('site', 'unit') AND "targetId" IS NOT NULL)
          ),
        CONSTRAINT "CHK_feeding_job_runs_semantic_identity"
          CHECK (
            (capability = 'scheduled.v2' AND "scheduleKind" <> 'on_demand')
            OR (capability <> 'scheduled.v2' AND "scheduleKind" = 'on_demand')
          )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_feeding_job_runs_scheduled_occurrence"
        ON farm.feeding_job_runs (
          "tenantId", "catalogJob", "targetKind", "targetId", "scheduleKey"
        ) NULLS NOT DISTINCT
        WHERE capability = 'scheduled.v2'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_feeding_job_runs_on_demand_request"
        ON farm.feeding_job_runs ("tenantId", "catalogJob", "scheduleKey")
        WHERE capability <> 'scheduled.v2'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_feeding_job_runs_reclaimable"
        ON farm.feeding_job_runs ("leaseExpiresAt")
        WHERE status = 'leased'
    `);
    await queryRunner.query(`
      ALTER TABLE farm.feeding_schedule_dispatches
        ADD CONSTRAINT "FK_feeding_schedule_dispatch_operation"
        FOREIGN KEY ("operationId") REFERENCES farm.feeding_job_runs("operationId")
        DEFERRABLE INITIALLY DEFERRED
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_job_run_transitions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "operationId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        generation bigint NOT NULL,
        attempt integer NOT NULL CHECK (attempt > 0),
        transition varchar(32) NOT NULL,
        evidence jsonb NOT NULL,
        "transitionedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "FK_feeding_job_transition_operation"
          FOREIGN KEY ("operationId") REFERENCES farm.feeding_job_runs("operationId"),
        CONSTRAINT "CHK_feeding_job_transition"
          CHECK (transition IN ('intent_created', 'lease_acquired', 'succeeded', 'failed')),
        CONSTRAINT "UQ_feeding_job_transition_state"
          UNIQUE ("operationId", attempt, transition)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_feeding_job_run_transitions_tenant_time"
        ON farm.feeding_job_run_transitions ("tenantId", "transitionedAt" DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE farm.feeding_scheduler_heartbeat (
        authority varchar(32) PRIMARY KEY,
        generation bigint NOT NULL CHECK (generation > 0),
        status varchar(16) NOT NULL,
        stage varchar(32) NOT NULL,
        "lastObservedAt" timestamptz NOT NULL,
        "lastAttemptAt" timestamptz NOT NULL,
        "lastSuccessAt" timestamptz,
        "lastFailureAt" timestamptz,
        "cutDigest" char(64),
        "dueCount" integer NOT NULL CHECK ("dueCount" >= 0),
        "dispositionCounts" jsonb NOT NULL,
        "failureDigests" jsonb NOT NULL,
        "readyBacklogCount" bigint NOT NULL CHECK ("readyBacklogCount" >= 0),
        "delayedBacklogCount" bigint NOT NULL CHECK ("delayedBacklogCount" >= 0),
        "leasedBacklogCount" bigint NOT NULL CHECK ("leasedBacklogCount" >= 0),
        "quarantinedCount" bigint NOT NULL CHECK ("quarantinedCount" >= 0),
        "rejectedCount" bigint NOT NULL CHECK ("rejectedCount" >= 0),
        "oldestOutstandingDueAt" timestamptz,
        evidence jsonb NOT NULL,
        "recordedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "CHK_feeding_scheduler_heartbeat_authority"
          CHECK (authority = '${FEEDING_MIGRATION_AUTHORITY_V1.schedulerObservability.authority}'),
        CONSTRAINT "CHK_feeding_scheduler_heartbeat_status"
          CHECK (status IN ('succeeded', 'failed')),
        CONSTRAINT "CHK_feeding_scheduler_heartbeat_stage"
          CHECK (stage IN ('compile', 'dispatch_projection', 'enqueue', 'complete')),
        CONSTRAINT "CHK_feeding_scheduler_heartbeat_terminal"
          CHECK (
            (status = 'succeeded' AND stage = 'complete' AND "lastSuccessAt" IS NOT NULL)
            OR (status = 'failed' AND stage <> 'complete' AND "lastFailureAt" IS NOT NULL)
          ),
        CONSTRAINT "CHK_feeding_scheduler_heartbeat_evidence_shape"
          CHECK (
            pg_catalog.jsonb_typeof(evidence) = 'object'
            AND pg_catalog.jsonb_typeof("dispositionCounts") = 'object'
            AND pg_catalog.jsonb_typeof("failureDigests") = 'array'
          )
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.reject_feeding_append_only_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $body$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $body$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.validate_feeding_catalog_entry_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_definition jsonb;
        v_match_count integer;
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(NEW."catalogDigest"::text, 0)
        );
        IF EXISTS (
          SELECT 1 FROM farm.feeding_catalog_admission_history h
           WHERE h."catalogDigest" = NEW."catalogDigest"
        ) THEN
          RAISE EXCEPTION 'feeding catalog % is sealed by admission', NEW."catalogDigest"
            USING ERRCODE = '55000';
        END IF;

        SELECT count(*)::integer, min(job.value::text)::jsonb
          INTO v_match_count, v_definition
          FROM farm.feeding_catalog_revisions root
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            root."canonicalJson"::jsonb->'jobs'
          ) AS job(value)
         WHERE root.digest = NEW."catalogDigest"
           AND job.value->>'id' = NEW.id;

        IF v_match_count <> 1 OR v_definition IS NULL THEN
          RAISE EXCEPTION 'feeding catalog entry % is absent or duplicated in canonical root', NEW.id
            USING ERRCODE = '23514';
        END IF;
        IF NEW.definition <> v_definition
           OR NEW.capability <> v_definition->>'capability'
           OR NEW."scheduleKind" <> v_definition->>'scheduleKind'
           OR NEW."clockProfile" <> v_definition->>'clockProfile'
           OR NEW."targetCardinality" <> v_definition->>'targetCardinality'
           OR NEW."timezoneSource" <> v_definition->>'timezoneSource'
           OR NEW."leaseSeconds" <> (v_definition->>'leaseSeconds')::integer
           OR NEW.enabled <> (v_definition->>'enabled')::boolean THEN
          RAISE EXCEPTION 'feeding catalog entry % does not equal canonical root definition', NEW.id
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $body$
    `);
    await queryRunner.query(`
      CREATE TRIGGER feeding_job_catalog_entry_validate
      BEFORE INSERT ON farm.feeding_job_catalog_entries
      FOR EACH ROW EXECUTE FUNCTION farm.validate_feeding_catalog_entry_insert()
    `);
    for (const table of [
      'feeding_catalog_revisions',
      'feeding_job_catalog_entries',
      'feeding_catalog_admission_history',
      'feeding_writer_authority_history',
      'feeding_schedule_dispatch_transitions',
      'feeding_job_run_transitions',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_append_only
        BEFORE UPDATE OR DELETE ON farm.${table}
        FOR EACH ROW EXECUTE FUNCTION farm.reject_feeding_append_only_mutation()
      `);
    }

    await queryRunner.query(`
      CREATE VIEW farm.feeding_job_run_projection
      WITH (security_barrier = true)
      AS
      SELECT r."tenantId", r.generation, r.capability, r."catalogJob", r."scheduleKind",
             r."clockProfile", r."targetKind", r."targetId", r."scheduleKey",
             r."localDate", r."observedAt", r."dueAt", r."caughtUp", r."dstGapAdjusted",
             r.timezone, r."timezoneSource", r."catalogAdmissionGeneration",
             r."authorityGeneration", r."targetSetDigest",
             r."schedulerCutDigest",
             c.revision AS "catalogRevision", r."catalogDigest", r."operationId", r.attempt,
             r.status, r.evidence, r."resultSchema", r."resultPayload", r."resultDigest",
             e.definition AS "catalogDefinition",
             r."startedAt", r."completedAt", r."updatedAt"
        FROM farm.feeding_job_runs r
        JOIN farm.feeding_catalog_revisions c ON c.digest = r."catalogDigest"
        JOIN farm.feeding_job_catalog_entries e
          ON e."catalogDigest" = r."catalogDigest" AND e.id = r."catalogJob"
    `);

    for (const relation of FEEDING_CONTROL_PLANE_RELATIONS) {
      await queryRunner.query(`REVOKE ALL ON ${relation.name} FROM PUBLIC`);
      await queryRunner.query(`REVOKE ALL ON ${relation.name} FROM ${FEEDING_RUNTIME_ROLE}`);
      await queryRunner.query(
        `ALTER ${relation.kind} ${relation.name} OWNER TO ${FEEDING_DATABASE_OWNER_ROLE}`,
      );
    }
    for (const sequence of FEEDING_CONTROL_PLANE_SEQUENCES) {
      await queryRunner.query(`REVOKE ALL ON SEQUENCE ${sequence} FROM PUBLIC`);
      await queryRunner.query(`REVOKE ALL ON SEQUENCE ${sequence} FROM ${FEEDING_RUNTIME_ROLE}`);
      await queryRunner.query(`ALTER SEQUENCE ${sequence} OWNER TO ${FEEDING_DATABASE_OWNER_ROLE}`);
    }
    for (const signature of FEEDING_CONTROL_PLANE_HELPER_FUNCTIONS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${FEEDING_RUNTIME_ROLE}`);
      await queryRunner.query(
        `ALTER FUNCTION ${signature} OWNER TO ${FEEDING_DATABASE_OWNER_ROLE}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS farm.feeding_job_run_projection`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_scheduler_heartbeat`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_job_run_transitions`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_schedule_dispatch_transitions`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_schedule_dispatches`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_job_runs`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_writer_authority_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_writer_authority`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_catalog_admission_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_catalog_admission`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_job_catalog_entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS farm.feeding_catalog_revisions`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.validate_feeding_catalog_entry_insert()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.reject_feeding_append_only_mutation()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.is_valid_feeding_catalog_job(jsonb)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.feeding_result_digest(varchar,text)`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS farm.feeding_result_hash_preimage(varchar,text)`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.is_valid_feeding_result_payload(jsonb)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.canonical_feeding_json(jsonb)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS farm.jsonb_has_exact_keys(jsonb,text[])`);
  }
}

bindFeedingMigrationExecutionScopeV1(
  CreateFeedingOperationControlPlane1808600000000,
  FEEDING_MIGRATION_AUTHORITY_V1.migrationExecution.declarations.createControlPlane,
);
