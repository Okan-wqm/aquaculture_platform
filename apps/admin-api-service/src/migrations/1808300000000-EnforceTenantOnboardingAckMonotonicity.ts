import type { MigrationInterface, QueryRunner } from 'typeorm';

const ROLLBACK_REFUSAL =
  'Refusing to remove the durable tenant onboarding admission and activation barrier';

/**
 * Converges the legacy onboarding tables into a generation-scoped evidence
 * ledger. No historical operation is assigned a catalog snapshot it never
 * observed: legacy rows remain explicitly unqualified until an operator asks
 * the workflow to retry them against the then-current compiled authority.
 */
export class EnforceTenantOnboardingAckMonotonicity1808300000000 implements MigrationInterface {
  name = 'EnforceTenantOnboardingAckMonotonicity1808300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $tenant_onboarding_baseline$
      DECLARE
        descriptor_mismatch JSONB;
        state_constraint TEXT;
        state_values TEXT[];
        ack_unique_constraint TEXT;
      BEGIN
        IF to_regclass('admin.tenant_provisioning_runs') IS NULL
          OR to_regclass('admin.tenant_provisioning_steps') IS NULL
          OR to_regclass('admin.tenant_onboarding_acks') IS NULL
          OR to_regclass('admin.admin_outbox') IS NULL THEN
          RAISE EXCEPTION 'tenant onboarding baseline tables are missing'
            USING ERRCODE = '55000';
        END IF;

        IF EXISTS (
          SELECT 1 FROM pg_class relation
           WHERE relation.oid = ANY(ARRAY[
             'admin.tenant_provisioning_runs'::regclass,
             'admin.tenant_provisioning_steps'::regclass,
             'admin.tenant_onboarding_acks'::regclass,
             'admin.admin_outbox'::regclass
           ]) AND relation.relowner <> (SELECT usesysid FROM pg_user WHERE usename = current_user)
        ) THEN
          RAISE EXCEPTION 'tenant onboarding baseline tables are not owned by the migration authority'
            USING ERRCODE = '55000';
        END IF;

        WITH expected(ordinal, name, type_name, not_null, identity_kind, default_expr) AS (
          VALUES
            (1, 'id', 'uuid', true, '', 'uuid_generate_v4()'),
            (2, 'tenantId', 'uuid', true, '', NULL),
            (3, 'idempotencyKey', 'character varying(128)', true, '', NULL),
            (4, 'requestHash', 'character varying(64)', true, '', NULL),
            (5, 'requestPayload', 'jsonb', true, '', '''{}''::jsonb'),
            (6, 'actorUserId', 'uuid', true, '', NULL),
            (7, 'state', 'character varying(20)', true, '', '''QUEUED''::character varying'),
            (8, 'currentStep', 'character varying(100)', false, '', NULL),
            (9, 'lastError', 'text', false, '', NULL),
            (10, 'attempts', 'integer', true, '', '0'),
            (11, 'nextRetryAt', 'timestamp with time zone', false, '', NULL),
            (12, 'leaseToken', 'uuid', false, '', NULL),
            (13, 'leasedBy', 'character varying(128)', false, '', NULL),
            (14, 'heartbeatAt', 'timestamp with time zone', false, '', NULL),
            (15, 'leaseExpiresAt', 'timestamp with time zone', false, '', NULL),
            (16, 'startedAt', 'timestamp with time zone', false, '', NULL),
            (17, 'completedAt', 'timestamp with time zone', false, '', NULL),
            (18, 'createdAt', 'timestamp with time zone', true, '', 'now()'),
            (19, 'updatedAt', 'timestamp with time zone', true, '', 'now()')
        ), actual AS (
          SELECT attribute.attnum::int AS ordinal, attribute.attname::text AS name,
                 format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
                 attribute.attnotnull AS not_null, attribute.attidentity::text AS identity_kind,
                 pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expr
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef attribute_default
              ON attribute_default.adrelid = attribute.attrelid
             AND attribute_default.adnum = attribute.attnum
           WHERE attribute.attrelid = 'admin.tenant_provisioning_runs'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
        )
        SELECT jsonb_agg(to_jsonb(diff) ORDER BY ordinal) INTO descriptor_mismatch
          FROM (
            SELECT COALESCE(expected.ordinal, actual.ordinal) AS ordinal,
                   to_jsonb(expected) AS expected, to_jsonb(actual) AS actual
              FROM expected FULL JOIN actual USING (ordinal)
             WHERE expected IS NULL OR actual IS NULL
                OR expected.name IS DISTINCT FROM actual.name
                OR expected.type_name IS DISTINCT FROM actual.type_name
                OR expected.not_null IS DISTINCT FROM actual.not_null
                OR expected.identity_kind IS DISTINCT FROM actual.identity_kind
                OR expected.default_expr IS DISTINCT FROM actual.default_expr
          ) diff;
        IF descriptor_mismatch IS NOT NULL THEN
          RAISE EXCEPTION 'tenant_provisioning_runs descriptor differs from governed baseline: %',
            descriptor_mismatch USING ERRCODE = '55000';
        END IF;

        WITH expected(ordinal, name, type_name, not_null, identity_kind, default_expr) AS (
          VALUES
            (1, 'id', 'uuid', true, '', 'uuid_generate_v4()'),
            (2, 'runId', 'uuid', true, '', NULL),
            (3, 'stepName', 'character varying(100)', true, '', NULL),
            (4, 'stepOrder', 'integer', true, '', '999'),
            (5, 'state', 'character varying(20)', true, '', '''QUEUED''::character varying'),
            (6, 'attempts', 'integer', true, '', '0'),
            (7, 'lastError', 'text', false, '', NULL),
            (8, 'startedAt', 'timestamp with time zone', false, '', NULL),
            (9, 'completedAt', 'timestamp with time zone', false, '', NULL),
            (10, 'createdAt', 'timestamp with time zone', true, '', 'now()'),
            (11, 'updatedAt', 'timestamp with time zone', true, '', 'now()')
        ), actual AS (
          SELECT attribute.attnum::int AS ordinal, attribute.attname::text AS name,
                 format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
                 attribute.attnotnull AS not_null, attribute.attidentity::text AS identity_kind,
                 pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expr
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef attribute_default
              ON attribute_default.adrelid = attribute.attrelid
             AND attribute_default.adnum = attribute.attnum
           WHERE attribute.attrelid = 'admin.tenant_provisioning_steps'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
        )
        SELECT jsonb_agg(to_jsonb(diff) ORDER BY ordinal) INTO descriptor_mismatch
          FROM (
            SELECT COALESCE(expected.ordinal, actual.ordinal) AS ordinal,
                   to_jsonb(expected) AS expected, to_jsonb(actual) AS actual
              FROM expected FULL JOIN actual USING (ordinal)
             WHERE expected IS NULL OR actual IS NULL
                OR expected.name IS DISTINCT FROM actual.name
                OR expected.type_name IS DISTINCT FROM actual.type_name
                OR expected.not_null IS DISTINCT FROM actual.not_null
                OR expected.identity_kind IS DISTINCT FROM actual.identity_kind
                OR expected.default_expr IS DISTINCT FROM actual.default_expr
          ) diff;
        IF descriptor_mismatch IS NOT NULL THEN
          RAISE EXCEPTION 'tenant_provisioning_steps descriptor differs from governed baseline: %',
            descriptor_mismatch USING ERRCODE = '55000';
        END IF;

        WITH expected(ordinal, name, type_name, not_null, identity_kind, default_expr) AS (
          VALUES
            (1, 'id', 'uuid', true, '', 'uuid_generate_v4()'),
            (2, 'operationId', 'uuid', true, '', NULL),
            (3, 'tenantId', 'uuid', true, '', NULL),
            (4, 'service', 'character varying(128)', true, '', NULL),
            (5, 'status', 'character varying(20)', true, '', NULL),
            (6, 'error', 'text', false, '', NULL),
            (7, 'acknowledgedAt', 'timestamp with time zone', false, '', NULL),
            (8, 'createdAt', 'timestamp with time zone', true, '', 'now()'),
            (9, 'updatedAt', 'timestamp with time zone', true, '', 'now()')
        ), actual AS (
          SELECT attribute.attnum::int AS ordinal, attribute.attname::text AS name,
                 format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
                 attribute.attnotnull AS not_null, attribute.attidentity::text AS identity_kind,
                 pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expr
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef attribute_default
              ON attribute_default.adrelid = attribute.attrelid
             AND attribute_default.adnum = attribute.attnum
           WHERE attribute.attrelid = 'admin.tenant_onboarding_acks'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
        )
        SELECT jsonb_agg(to_jsonb(diff) ORDER BY ordinal) INTO descriptor_mismatch
          FROM (
            SELECT COALESCE(expected.ordinal, actual.ordinal) AS ordinal,
                   to_jsonb(expected) AS expected, to_jsonb(actual) AS actual
              FROM expected FULL JOIN actual USING (ordinal)
             WHERE expected IS NULL OR actual IS NULL
                OR expected.name IS DISTINCT FROM actual.name
                OR expected.type_name IS DISTINCT FROM actual.type_name
                OR expected.not_null IS DISTINCT FROM actual.not_null
                OR expected.identity_kind IS DISTINCT FROM actual.identity_kind
                OR expected.default_expr IS DISTINCT FROM actual.default_expr
          ) diff;
        IF descriptor_mismatch IS NOT NULL THEN
          RAISE EXCEPTION 'tenant_onboarding_acks descriptor differs from governed baseline: %',
            descriptor_mismatch USING ERRCODE = '55000';
        END IF;

        WITH expected(ordinal, name, type_name, not_null, identity_kind, default_expr) AS (
          VALUES
            (1, 'id', 'bigint', true, 'd', NULL),
            (2, 'eventType', 'character varying(100)', true, '', NULL),
            (3, 'tenantId', 'uuid', false, '', NULL),
            (4, 'aggregateId', 'uuid', false, '', NULL),
            (5, 'payload', 'jsonb', true, '', NULL),
            (6, 'createdAt', 'timestamp with time zone', true, '', 'now()'),
            (7, 'publishedAt', 'timestamp with time zone', false, '', NULL),
            (8, 'retryCount', 'integer', true, '', '0'),
            (9, 'lastError', 'text', false, '', NULL),
            (10, 'nextAttemptAt', 'timestamp with time zone', false, '', NULL),
            (11, 'idempotencyKey', 'character varying(255)', false, '', NULL),
            (12, 'isDeadLettered', 'boolean', true, '', 'false'),
            (13, 'leasedAt', 'timestamp with time zone', false, '', NULL),
            (14, 'leasedBy', 'character varying(128)', false, '', NULL)
        ), actual AS (
          SELECT attribute.attnum::int AS ordinal, attribute.attname::text AS name,
                 format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
                 attribute.attnotnull AS not_null, attribute.attidentity::text AS identity_kind,
                 pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_expr
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef attribute_default
              ON attribute_default.adrelid = attribute.attrelid
             AND attribute_default.adnum = attribute.attnum
           WHERE attribute.attrelid = 'admin.admin_outbox'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped
        )
        SELECT jsonb_agg(to_jsonb(diff) ORDER BY ordinal) INTO descriptor_mismatch
          FROM (
            SELECT COALESCE(expected.ordinal, actual.ordinal) AS ordinal,
                   to_jsonb(expected) AS expected, to_jsonb(actual) AS actual
              FROM expected FULL JOIN actual USING (ordinal)
             WHERE expected IS NULL OR actual IS NULL
                OR expected.name IS DISTINCT FROM actual.name
                OR expected.type_name IS DISTINCT FROM actual.type_name
                OR expected.not_null IS DISTINCT FROM actual.not_null
                OR expected.identity_kind IS DISTINCT FROM actual.identity_kind
                OR expected.default_expr IS DISTINCT FROM actual.default_expr
          ) diff;
        IF descriptor_mismatch IS NOT NULL THEN
          RAISE EXCEPTION 'admin_outbox descriptor differs from governed baseline: %',
            descriptor_mismatch USING ERRCODE = '55000';
        END IF;

        SELECT pg_get_constraintdef(oid, true) INTO state_constraint
          FROM pg_constraint
         WHERE conrelid = 'admin.tenant_provisioning_runs'::regclass
           AND conname = 'chk_tenant_provisioning_runs_state' AND contype = 'c';
        SELECT array_agg(capture[1] ORDER BY capture[1]) INTO state_values
          FROM regexp_matches(COALESCE(state_constraint, ''), '''([A-Z_]+)''', 'g') capture;
        IF state_values IS DISTINCT FROM ARRAY[
          'FAILED', 'QUEUED', 'RESERVING', 'RUNNING', 'SUCCEEDED'
        ]::TEXT[] THEN
          RAISE EXCEPTION 'tenant provisioning state constraint differs from governed baseline: %',
            state_constraint USING ERRCODE = '55000';
        END IF;

        SELECT pg_get_constraintdef(oid, true) INTO ack_unique_constraint
          FROM pg_constraint
         WHERE conrelid = 'admin.tenant_onboarding_acks'::regclass
           AND conname = 'uk_tenant_onboarding_acks_operation_service' AND contype = 'u';
        IF ack_unique_constraint IS DISTINCT FROM 'UNIQUE ("operationId", service)' THEN
          RAISE EXCEPTION 'tenant onboarding ACK uniqueness differs from governed baseline: %',
            ack_unique_constraint USING ERRCODE = '55000';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_index index_definition
           WHERE index_definition.indexrelid = 'admin.idx_admin_outbox_idempotency'::regclass
             AND index_definition.indisunique
             AND pg_get_expr(index_definition.indpred, index_definition.indrelid) =
                   '("idempotencyKey" IS NOT NULL)'
        ) THEN
          RAISE EXCEPTION 'admin outbox idempotency index differs from governed baseline'
            USING ERRCODE = '55000';
        END IF;

        IF to_regprocedure('digest(bytea,text)') IS NULL THEN
          RAISE EXCEPTION 'pgcrypto digest(bytea,text) is required for onboarding evidence roots'
            USING ERRCODE = '55000';
        END IF;
      END
      $tenant_onboarding_baseline$
    `);

    await queryRunner.query(`
      CREATE TABLE "admin"."tenant_onboarding_acks_legacy" (
        "id" UUID PRIMARY KEY,
        "operationId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "service" VARCHAR(128) NOT NULL,
        "status" VARCHAR(20) NOT NULL,
        "error" TEXT NULL,
        "acknowledgedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL,
        "archivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_tenant_onboarding_acks_legacy_status"
          CHECK ("status" IN ('ACK', 'FAILED'))
      )
    `);

    await queryRunner.query(`
      INSERT INTO "admin"."tenant_onboarding_acks_legacy" (
        "id", "operationId", "tenantId", "service", "status", "error",
        "acknowledgedAt", "createdAt", "updatedAt"
      )
      SELECT "id", "operationId", "tenantId", "service", "status", "error",
             "acknowledgedAt", "createdAt", "updatedAt"
        FROM "admin"."tenant_onboarding_acks";

      DELETE FROM "admin"."tenant_onboarding_acks"
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."guard_tenant_onboarding_legacy_archive"()
      RETURNS trigger LANGUAGE plpgsql
      AS $tenant_onboarding_legacy_archive$
      BEGIN
        RAISE EXCEPTION 'legacy tenant onboarding evidence is append-only'
          USING ERRCODE = '23514';
      END
      $tenant_onboarding_legacy_archive$;

      CREATE TRIGGER "trg_tenant_onboarding_legacy_archive"
        BEFORE UPDATE OR DELETE ON "admin"."tenant_onboarding_acks_legacy"
        FOR EACH ROW EXECUTE FUNCTION "admin"."guard_tenant_onboarding_legacy_archive"()
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_provisioning_runs"
        ADD COLUMN "onboardingQualification" VARCHAR(32) NULL,
        ADD COLUMN "onboardingGeneration" INTEGER NULL,
        ADD COLUMN "onboardingRequirements" JSONB NULL,
        ADD COLUMN "onboardingRequirementsDigest" CHAR(64) NULL,
        ADD COLUMN "onboardingRequestedAt" TIMESTAMPTZ NULL,
        ADD COLUMN "onboardingDeadlineAt" TIMESTAMPTZ NULL,
        ADD COLUMN "onboardingPublicationOutboxId" BIGINT NULL,
        ADD COLUMN "onboardingPublicationEventId" UUID NULL,
        ADD COLUMN "onboardingPublicationDigest" CHAR(64) NULL,
        ADD COLUMN "onboardingSealGeneration" INTEGER NULL,
        ADD COLUMN "onboardingSealEvidence" JSONB NULL,
        ADD COLUMN "onboardingSealEvidenceRoot" CHAR(64) NULL,
        ADD COLUMN "onboardingSealToken" UUID NULL,
        ADD COLUMN "onboardingActivationConsumedAt" TIMESTAMPTZ NULL,
        ADD COLUMN "onboardingSafetyFailure" JSONB NULL
    `);

    await queryRunner.query(`
      UPDATE "admin"."tenant_provisioning_runs"
         SET "onboardingQualification" = 'LEGACY_UNQUALIFIED',
             state = CASE
               WHEN state IN ('QUEUED', 'RESERVING', 'RUNNING') THEN 'FAILED'
               ELSE state
             END,
             "lastError" = CASE
               WHEN state IN ('QUEUED', 'RESERVING', 'RUNNING')
               THEN 'Legacy onboarding run requires an explicit catalog-qualified retry'
               ELSE "lastError"
             END,
             "nextRetryAt" = NULL,
             "leaseToken" = NULL,
             "leasedBy" = NULL,
             "heartbeatAt" = NULL,
             "leaseExpiresAt" = NULL,
             "completedAt" = CASE
               WHEN state IN ('QUEUED', 'RESERVING', 'RUNNING') THEN now()
               ELSE "completedAt"
             END,
             "updatedAt" = now()
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_provisioning_runs"
        ALTER COLUMN "onboardingQualification" SET NOT NULL,
        DROP CONSTRAINT "chk_tenant_provisioning_runs_state",
        ADD CONSTRAINT "chk_tenant_provisioning_runs_state" CHECK (
          state IN ('QUEUED', 'RESERVING', 'RUNNING', 'WAITING_ONBOARDING', 'SUCCEEDED', 'FAILED')
        ),
        ADD CONSTRAINT "chk_tenant_provisioning_onboarding_authority" CHECK (
          (
            "onboardingQualification" = 'LEGACY_UNQUALIFIED'
            AND state IN ('SUCCEEDED', 'FAILED')
            AND "onboardingGeneration" IS NULL
            AND "onboardingRequirements" IS NULL
            AND "onboardingRequirementsDigest" IS NULL
            AND "onboardingRequestedAt" IS NULL
            AND "onboardingDeadlineAt" IS NULL
            AND "onboardingPublicationOutboxId" IS NULL
            AND "onboardingPublicationEventId" IS NULL
            AND "onboardingPublicationDigest" IS NULL
            AND "onboardingSealGeneration" IS NULL
            AND "onboardingSealEvidence" IS NULL
            AND "onboardingSealEvidenceRoot" IS NULL
            AND "onboardingSealToken" IS NULL
            AND "onboardingActivationConsumedAt" IS NULL
            AND "onboardingSafetyFailure" IS NULL
          ) OR (
            "onboardingQualification" = 'QUALIFIED'
            AND "onboardingGeneration" >= 1
            AND jsonb_typeof("onboardingRequirements") = 'object'
            AND jsonb_typeof("onboardingRequirements" -> 'requiredServices') = 'array'
            AND jsonb_array_length("onboardingRequirements" -> 'requiredServices') > 0
            AND "onboardingRequirements" ->> 'snapshotDigest' =
                  "onboardingRequirementsDigest"
            AND "onboardingRequirementsDigest" ~ '^[0-9a-f]{64}$'
            AND (
              ("onboardingRequestedAt" IS NULL
                AND "onboardingDeadlineAt" IS NULL
                AND "onboardingPublicationOutboxId" IS NULL
                AND "onboardingPublicationEventId" IS NULL
                AND "onboardingPublicationDigest" IS NULL)
              OR
              ("onboardingRequestedAt" IS NOT NULL
                AND "onboardingDeadlineAt" IS NOT NULL
                AND "onboardingPublicationOutboxId" IS NOT NULL
                AND "onboardingPublicationEventId" IS NOT NULL
                AND "onboardingPublicationDigest" ~ '^[0-9a-f]{64}$')
            )
            AND (
              ("onboardingSealToken" IS NULL
                AND "onboardingSealGeneration" IS NULL
                AND "onboardingSealEvidence" IS NULL
                AND "onboardingSealEvidenceRoot" IS NULL
                AND "onboardingActivationConsumedAt" IS NULL)
              OR
              ("onboardingSealToken" IS NOT NULL
                AND "onboardingSealGeneration" = "onboardingGeneration"
                AND jsonb_typeof("onboardingSealEvidence") = 'array'
                AND "onboardingSealEvidenceRoot" ~ '^[0-9a-f]{64}$')
            )
            AND ("onboardingSafetyFailure" IS NULL
              OR jsonb_typeof("onboardingSafetyFailure") = 'object')
          )
        ),
        ADD CONSTRAINT "uk_tenant_provisioning_runs_id_tenant"
          UNIQUE ("id", "tenantId"),
        ADD CONSTRAINT "uk_tenant_provisioning_runs_generation"
          UNIQUE ("id", "tenantId", "onboardingGeneration")
    `);

    await queryRunner.query(`
      CREATE TABLE "admin"."tenant_onboarding_requirements" (
        "operationId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "generation" INTEGER NOT NULL,
        "service" VARCHAR(128) NOT NULL,
        "requirementsDigest" CHAR(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenant_onboarding_requirements"
          PRIMARY KEY ("operationId", "tenantId", "generation", "service"),
        CONSTRAINT "fk_tenant_onboarding_requirements_run_generation"
          FOREIGN KEY ("operationId", "tenantId", "generation")
          REFERENCES "admin"."tenant_provisioning_runs"(
            "id", "tenantId", "onboardingGeneration"
          ),
        CONSTRAINT "chk_tenant_onboarding_requirement_identity" CHECK (
          "generation" >= 1 AND length("service") > 0
          AND "requirementsDigest" ~ '^[0-9a-f]{64}$'
        )
      )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."guard_tenant_onboarding_requirement"()
      RETURNS trigger LANGUAGE plpgsql
      AS $tenant_onboarding_requirement_guard$
      DECLARE
        run_authority RECORD;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          RAISE EXCEPTION 'tenant onboarding requirements are immutable'
            USING ERRCODE = '23514';
        END IF;
        SELECT "onboardingQualification", "onboardingGeneration",
               "onboardingRequirements", "onboardingRequirementsDigest"
          INTO run_authority
          FROM "admin"."tenant_provisioning_runs"
         WHERE id = NEW."operationId" AND "tenantId" = NEW."tenantId";
        IF run_authority."onboardingQualification" IS DISTINCT FROM 'QUALIFIED'
          OR run_authority."onboardingGeneration" IS DISTINCT FROM NEW.generation
          OR NOT ((run_authority."onboardingRequirements" -> 'requiredServices') ? NEW.service)
          OR run_authority."onboardingRequirementsDigest" IS DISTINCT FROM NEW."requirementsDigest" THEN
          RAISE EXCEPTION 'tenant onboarding requirement does not match its operation generation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $tenant_onboarding_requirement_guard$;

      CREATE TRIGGER "trg_tenant_onboarding_requirement_guard"
        BEFORE INSERT OR UPDATE OR DELETE ON "admin"."tenant_onboarding_requirements"
        FOR EACH ROW EXECUTE FUNCTION "admin"."guard_tenant_onboarding_requirement"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."guard_tenant_onboarding_authority"()
      RETURNS trigger LANGUAGE plpgsql
      AS $tenant_onboarding_authority_guard$
      BEGIN
        IF OLD."onboardingQualification" = 'LEGACY_UNQUALIFIED' THEN
          IF NEW."onboardingQualification" = 'LEGACY_UNQUALIFIED' THEN
            RETURN NEW;
          END IF;
          IF NEW."onboardingQualification" <> 'QUALIFIED'
            OR OLD.state <> 'FAILED' OR NEW.state <> 'QUEUED'
            OR NEW."onboardingGeneration" <> 1 THEN
            RAISE EXCEPTION 'legacy onboarding authority requires explicit failed-run qualification'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW."onboardingQualification" <> 'QUALIFIED'
          OR NEW."onboardingRequirements" IS DISTINCT FROM OLD."onboardingRequirements"
          OR NEW."onboardingRequirementsDigest" IS DISTINCT FROM OLD."onboardingRequirementsDigest" THEN
          RAISE EXCEPTION 'qualified onboarding snapshot is immutable'
            USING ERRCODE = '23514';
        END IF;

        IF NEW."onboardingGeneration" <> OLD."onboardingGeneration" THEN
          IF NEW."onboardingGeneration" <> OLD."onboardingGeneration" + 1
            OR OLD.state <> 'FAILED' OR NEW.state <> 'QUEUED'
            OR NEW."onboardingRequestedAt" IS NOT NULL OR NEW."onboardingDeadlineAt" IS NOT NULL
            OR NEW."onboardingPublicationOutboxId" IS NOT NULL
            OR NEW."onboardingPublicationEventId" IS NOT NULL
            OR NEW."onboardingPublicationDigest" IS NOT NULL
            OR NEW."onboardingSealToken" IS NOT NULL
            OR NEW."onboardingSafetyFailure" IS NOT NULL THEN
            RAISE EXCEPTION 'onboarding generation can advance only through explicit failed-run retry'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END IF;

        IF OLD."onboardingRequestedAt" IS NOT NULL AND (
          NEW."onboardingRequestedAt" IS DISTINCT FROM OLD."onboardingRequestedAt"
          OR NEW."onboardingDeadlineAt" IS DISTINCT FROM OLD."onboardingDeadlineAt"
          OR NEW."onboardingPublicationOutboxId" IS DISTINCT FROM OLD."onboardingPublicationOutboxId"
          OR NEW."onboardingPublicationEventId" IS DISTINCT FROM OLD."onboardingPublicationEventId"
          OR NEW."onboardingPublicationDigest" IS DISTINCT FROM OLD."onboardingPublicationDigest"
        ) THEN
          RAISE EXCEPTION 'onboarding request window is immutable within a generation'
            USING ERRCODE = '23514';
        END IF;
        IF OLD."onboardingSealToken" IS NOT NULL AND (
          NEW."onboardingSealGeneration" IS DISTINCT FROM OLD."onboardingSealGeneration"
          OR NEW."onboardingSealEvidence" IS DISTINCT FROM OLD."onboardingSealEvidence"
          OR NEW."onboardingSealEvidenceRoot" IS DISTINCT FROM OLD."onboardingSealEvidenceRoot"
          OR NEW."onboardingSealToken" IS DISTINCT FROM OLD."onboardingSealToken"
          OR (OLD."onboardingActivationConsumedAt" IS NOT NULL
            AND NEW."onboardingActivationConsumedAt" IS DISTINCT FROM OLD."onboardingActivationConsumedAt")
        ) THEN
          RAISE EXCEPTION 'onboarding activation seal is immutable within a generation'
            USING ERRCODE = '23514';
        END IF;
        IF OLD."onboardingSafetyFailure" IS NOT NULL
          AND NEW."onboardingSafetyFailure" IS DISTINCT FROM OLD."onboardingSafetyFailure" THEN
          RAISE EXCEPTION 'onboarding safety failure is immutable within a generation'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $tenant_onboarding_authority_guard$;

      CREATE TRIGGER "trg_tenant_onboarding_authority_guard"
        BEFORE UPDATE ON "admin"."tenant_provisioning_runs"
        FOR EACH ROW EXECUTE FUNCTION "admin"."guard_tenant_onboarding_authority"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."assert_tenant_onboarding_publication"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER
      ) RETURNS TABLE (
        "outboxId" BIGINT, "eventId" UUID, "publicationDigest" TEXT,
        "requestedAt" TIMESTAMPTZ, "deadlineAt" TIMESTAMPTZ
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_publication_assertion$
      DECLARE
        run_authority RECORD;
        outbox_authority RECORD;
        publication_core JSONB;
        actual_digest TEXT;
        expected_key TEXT;
      BEGIN
        SELECT * INTO run_authority
          FROM admin.tenant_provisioning_runs
         WHERE id = requested_operation_id AND "tenantId" = requested_tenant_id
           AND "onboardingQualification" = 'QUALIFIED'
           AND "onboardingGeneration" = requested_generation;
        IF NOT FOUND OR run_authority."onboardingPublicationOutboxId" IS NULL THEN
          RAISE EXCEPTION 'tenant onboarding publication is not sealed'
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO outbox_authority
          FROM admin.admin_outbox
         WHERE id = run_authority."onboardingPublicationOutboxId";
        expected_key := 'tenant-onboarding-requested:' || requested_operation_id::text
          || ':generation:' || requested_generation::text;
        IF NOT FOUND
          OR outbox_authority."eventType" <> 'TenantOnboardingRequested'
          OR outbox_authority."tenantId" <> requested_tenant_id
          OR outbox_authority."aggregateId" <> requested_tenant_id
          OR outbox_authority."idempotencyKey" <> expected_key
          OR outbox_authority.payload ->> 'eventType' <> 'TenantOnboardingRequested'
          OR outbox_authority.payload ->> 'tenantId' <> requested_tenant_id::text
          OR outbox_authority.payload ->> 'aggregateId' <> requested_tenant_id::text
          OR outbox_authority.payload ->> 'operationId' <> requested_operation_id::text
          OR outbox_authority.payload ->> 'generation' <> requested_generation::text
          OR outbox_authority.payload ->> 'eventId' <>
               run_authority."onboardingPublicationEventId"::text THEN
          RAISE EXCEPTION 'tenant onboarding publication outbox identity is inconsistent'
            USING ERRCODE = '23514';
        END IF;
        publication_core := jsonb_build_object(
          'outboxId', outbox_authority.id,
          'eventType', outbox_authority."eventType",
          'tenantId', outbox_authority."tenantId",
          'aggregateId', outbox_authority."aggregateId",
          'idempotencyKey', outbox_authority."idempotencyKey",
          'payload', outbox_authority.payload,
          'createdAt', outbox_authority."createdAt"
        );
        actual_digest := encode(public.digest(
          convert_to('tenant-onboarding-publication.v1', 'UTF8')
            || decode('00', 'hex')
            || convert_to(publication_core::text, 'UTF8'),
          'sha256'
        ), 'hex');
        IF actual_digest <> run_authority."onboardingPublicationDigest"
          OR outbox_authority."createdAt" <> run_authority."onboardingRequestedAt"
          OR run_authority."onboardingDeadlineAt" <> outbox_authority."createdAt" + (
            (run_authority."onboardingRequirements" ->> 'ackDeadlineMs') || ' milliseconds'
          )::interval THEN
          RAISE EXCEPTION 'tenant onboarding publication digest or request window is inconsistent'
            USING ERRCODE = '23514';
        END IF;
        "outboxId" := outbox_authority.id;
        "eventId" := run_authority."onboardingPublicationEventId";
        "publicationDigest" := actual_digest;
        "requestedAt" := run_authority."onboardingRequestedAt";
        "deadlineAt" := run_authority."onboardingDeadlineAt";
        RETURN NEXT;
      END
      $tenant_onboarding_publication_assertion$;

      CREATE FUNCTION "admin"."publish_tenant_onboarding_request"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER,
        requested_payload JSONB
      ) RETURNS TABLE (
        "outboxId" BIGINT, "eventId" UUID, "publicationDigest" TEXT,
        "requestedAt" TIMESTAMPTZ, "deadlineAt" TIMESTAMPTZ
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_publication$
      DECLARE
        run_authority RECORD;
        inserted_outbox RECORD;
        publication_core JSONB;
        publication_digest TEXT;
        expected_key TEXT;
        payload_event_id UUID;
      BEGIN
        SELECT * INTO run_authority
          FROM admin.tenant_provisioning_runs
         WHERE id = requested_operation_id AND "tenantId" = requested_tenant_id
         FOR UPDATE;
        IF NOT FOUND OR run_authority."onboardingQualification" <> 'QUALIFIED'
          OR run_authority."onboardingGeneration" <> requested_generation
          OR run_authority."onboardingRequestedAt" IS NOT NULL
          OR run_authority."onboardingDeadlineAt" IS NOT NULL
          OR run_authority."onboardingPublicationOutboxId" IS NOT NULL
          OR run_authority."onboardingSealToken" IS NOT NULL
          OR run_authority."onboardingSafetyFailure" IS NOT NULL THEN
          RAISE EXCEPTION 'tenant onboarding publication generation is already sealed or unavailable'
            USING ERRCODE = '23514';
        END IF;
        IF jsonb_typeof(requested_payload) <> 'object'
          OR requested_payload ->> 'eventType' <> 'TenantOnboardingRequested'
          OR requested_payload ->> 'tenantId' <> requested_tenant_id::text
          OR requested_payload ->> 'aggregateId' <> requested_tenant_id::text
          OR requested_payload ->> 'aggregateType' <> 'Tenant'
          OR requested_payload ->> 'operationId' <> requested_operation_id::text
          OR requested_payload ->> 'generation' <> requested_generation::text
          OR COALESCE(requested_payload ->> 'eventId', '') !~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR jsonb_typeof(requested_payload -> 'moduleIds') <> 'array'
          OR COALESCE(length(requested_payload ->> 'slug'), 0) = 0
          OR COALESCE(length(requested_payload ->> 'name'), 0) = 0 THEN
          RAISE EXCEPTION 'tenant onboarding publication payload violates its governed identity'
            USING ERRCODE = '23514';
        END IF;
        payload_event_id := (requested_payload ->> 'eventId')::uuid;
        expected_key := 'tenant-onboarding-requested:' || requested_operation_id::text
          || ':generation:' || requested_generation::text;
        INSERT INTO admin.admin_outbox (
          "eventType", "tenantId", "aggregateId", payload, "idempotencyKey",
          "retryCount", "isDeadLettered", "createdAt"
        ) VALUES (
          'TenantOnboardingRequested', requested_tenant_id, requested_tenant_id,
          requested_payload, expected_key, 0, false, clock_timestamp()
        ) ON CONFLICT ("tenantId", "idempotencyKey")
          WHERE "idempotencyKey" IS NOT NULL DO NOTHING
        RETURNING * INTO inserted_outbox;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'pre-existing unsealed tenant onboarding outbox identity detected'
            USING ERRCODE = '23514';
        END IF;
        publication_core := jsonb_build_object(
          'outboxId', inserted_outbox.id,
          'eventType', inserted_outbox."eventType",
          'tenantId', inserted_outbox."tenantId",
          'aggregateId', inserted_outbox."aggregateId",
          'idempotencyKey', inserted_outbox."idempotencyKey",
          'payload', inserted_outbox.payload,
          'createdAt', inserted_outbox."createdAt"
        );
        publication_digest := encode(public.digest(
          convert_to('tenant-onboarding-publication.v1', 'UTF8')
            || decode('00', 'hex')
            || convert_to(publication_core::text, 'UTF8'),
          'sha256'
        ), 'hex');
        UPDATE admin.tenant_provisioning_runs
           SET "onboardingRequestedAt" = inserted_outbox."createdAt",
               "onboardingDeadlineAt" = inserted_outbox."createdAt" + (
                 ("onboardingRequirements" ->> 'ackDeadlineMs') || ' milliseconds'
               )::interval,
               "onboardingPublicationOutboxId" = inserted_outbox.id,
               "onboardingPublicationEventId" = payload_event_id,
               "onboardingPublicationDigest" = publication_digest,
               "updatedAt" = clock_timestamp()
         WHERE id = requested_operation_id;
        RETURN QUERY SELECT * FROM admin.assert_tenant_onboarding_publication(
          requested_operation_id, requested_tenant_id, requested_generation
        );
      END
      $tenant_onboarding_publication$;
    `);

    await queryRunner.query(`
      ALTER TABLE "admin"."tenant_onboarding_acks"
        ADD COLUMN "generation" INTEGER NULL,
        ADD COLUMN "requirementsDigest" CHAR(64) NULL,
        ADD COLUMN "admissionPayload" JSONB NULL,
        DROP CONSTRAINT "uk_tenant_onboarding_acks_operation_service",
        DROP CONSTRAINT "chk_tenant_onboarding_acks_status",
        ALTER COLUMN "acknowledgedAt" SET NOT NULL,
        ALTER COLUMN "generation" SET NOT NULL,
        ALTER COLUMN "requirementsDigest" SET NOT NULL,
        ALTER COLUMN "admissionPayload" SET NOT NULL,
        ADD CONSTRAINT "uk_tenant_onboarding_ack_generation_service"
          UNIQUE ("operationId", "tenantId", "generation", "service"),
        ADD CONSTRAINT "chk_tenant_onboarding_ack_outcome" CHECK (
          (status = 'ACK' AND error IS NULL)
          OR (status = 'FAILED' AND error IS NOT NULL AND length(error) > 0)
        ),
        ADD CONSTRAINT "chk_tenant_onboarding_ack_payload" CHECK (
          "admissionPayload" = jsonb_strip_nulls(jsonb_build_object(
            'operationId', "operationId", 'tenantId', "tenantId",
            'generation', "generation", 'service', "service",
            'requirementsDigest', "requirementsDigest", 'status', status,
            'error', error, 'acknowledgedAt', "acknowledgedAt"
          ))
        ),
        ADD CONSTRAINT "fk_tenant_onboarding_ack_requirement"
          FOREIGN KEY ("operationId", "tenantId", "generation", "service")
          REFERENCES "admin"."tenant_onboarding_requirements"(
            "operationId", "tenantId", "generation", "service"
          )
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."guard_tenant_onboarding_ack_immutability"()
      RETURNS trigger LANGUAGE plpgsql
      AS $tenant_onboarding_ack_immutability$
      BEGIN
        RAISE EXCEPTION 'tenant onboarding terminal outcomes are immutable'
          USING ERRCODE = '23514';
      END
      $tenant_onboarding_ack_immutability$;

      CREATE TRIGGER "trg_tenant_onboarding_ack_immutability"
        BEFORE UPDATE OR DELETE ON "admin"."tenant_onboarding_acks"
        FOR EACH ROW EXECUTE FUNCTION "admin"."guard_tenant_onboarding_ack_immutability"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."admit_tenant_onboarding_outcome"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER,
        requested_service TEXT,
        requested_status TEXT,
        requested_error TEXT,
        requested_acknowledged_at TIMESTAMPTZ
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_outcome_admission$
      DECLARE
        run_authority RECORD;
        requirement_digest CHAR(64);
        canonical_payload JSONB;
        existing_payload JSONB;
      BEGIN
        SELECT * INTO run_authority
          FROM admin.tenant_provisioning_runs
         WHERE id = requested_operation_id AND "tenantId" = requested_tenant_id
         FOR UPDATE;
        IF NOT FOUND OR run_authority."onboardingQualification" <> 'QUALIFIED'
          OR run_authority."onboardingGeneration" <> requested_generation THEN
          RAISE EXCEPTION 'tenant onboarding outcome targets a stale or unqualified generation'
            USING ERRCODE = '23514';
        END IF;
        IF run_authority."onboardingRequestedAt" IS NULL
          OR requested_acknowledged_at < run_authority."onboardingRequestedAt"
          OR requested_acknowledged_at > run_authority."onboardingDeadlineAt" THEN
          RAISE EXCEPTION 'tenant onboarding outcome is outside its request window'
            USING ERRCODE = '23514';
        END IF;
        IF (requested_status = 'ACK' AND requested_error IS NOT NULL)
          OR (requested_status = 'FAILED' AND COALESCE(length(requested_error), 0) = 0)
          OR requested_status NOT IN ('ACK', 'FAILED') THEN
          RAISE EXCEPTION 'tenant onboarding outcome is malformed'
            USING ERRCODE = '23514';
        END IF;

        SELECT "requirementsDigest" INTO requirement_digest
          FROM admin.tenant_onboarding_requirements
         WHERE "operationId" = requested_operation_id
           AND "tenantId" = requested_tenant_id
           AND generation = requested_generation
           AND service = requested_service;
        IF requirement_digest IS NULL
          OR requirement_digest <> run_authority."onboardingRequirementsDigest" THEN
          RAISE EXCEPTION 'tenant onboarding outcome has no matching requirement authority'
            USING ERRCODE = '23514';
        END IF;

        canonical_payload := jsonb_strip_nulls(jsonb_build_object(
          'operationId', requested_operation_id, 'tenantId', requested_tenant_id,
          'generation', requested_generation, 'service', requested_service,
          'requirementsDigest', requirement_digest, 'status', requested_status,
          'error', requested_error, 'acknowledgedAt', requested_acknowledged_at
        ));
        INSERT INTO admin.tenant_onboarding_acks (
          id, "operationId", "tenantId", generation, service, "requirementsDigest",
          status, error, "acknowledgedAt", "admissionPayload", "createdAt", "updatedAt"
        ) VALUES (
          public.uuid_generate_v4(), requested_operation_id, requested_tenant_id,
          requested_generation, requested_service, requirement_digest,
          requested_status, requested_error, requested_acknowledged_at,
          canonical_payload, now(), now()
        ) ON CONFLICT ("operationId", "tenantId", generation, service) DO NOTHING;
        IF FOUND THEN
          UPDATE admin.tenant_provisioning_runs
             SET state = CASE WHEN state = 'WAITING_ONBOARDING' THEN 'QUEUED' ELSE state END,
                 "nextRetryAt" = CASE WHEN state = 'WAITING_ONBOARDING' THEN now() ELSE "nextRetryAt" END,
                 "lastError" = CASE WHEN state = 'WAITING_ONBOARDING' THEN NULL ELSE "lastError" END,
                 "updatedAt" = now()
           WHERE id = requested_operation_id;
          RETURN 'ADMITTED';
        END IF;

        SELECT "admissionPayload" INTO existing_payload
          FROM admin.tenant_onboarding_acks
         WHERE "operationId" = requested_operation_id
           AND "tenantId" = requested_tenant_id
           AND generation = requested_generation
           AND service = requested_service;
        IF existing_payload = canonical_payload THEN
          RETURN 'DUPLICATE';
        END IF;

        IF run_authority."onboardingActivationConsumedAt" IS NOT NULL THEN
          RETURN 'REJECTED_AFTER_ACTIVATION';
        END IF;

        UPDATE admin.tenant_provisioning_runs
           SET "onboardingSafetyFailure" = COALESCE(
                 "onboardingSafetyFailure",
                 jsonb_build_object(
                   'code', 'CONTRADICTORY_TERMINAL_OUTCOME',
                   'generation', requested_generation,
                   'service', requested_service,
                   'existingEvidence', existing_payload,
                   'rejectedEvidence', canonical_payload,
                   'detectedAt', now()
                 )
               ),
               state = 'FAILED',
               "lastError" = 'Contradictory tenant onboarding terminal outcome',
               "nextRetryAt" = NULL,
               "updatedAt" = now()
         WHERE id = requested_operation_id;
        RETURN 'SAFETY_FAILED';
      END
      $tenant_onboarding_outcome_admission$;
    `);

    await queryRunner.query(`
      CREATE FUNCTION "admin"."tenant_onboarding_evidence"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER
      ) RETURNS JSONB
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_evidence$
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'service', requirement.service,
          'requirementsDigest', requirement."requirementsDigest",
          'status', acknowledgement.status,
          'acknowledgedAt', acknowledgement."acknowledgedAt"
        ) ORDER BY requirement.service), '[]'::jsonb)
          FROM admin.tenant_onboarding_requirements requirement
          LEFT JOIN admin.tenant_onboarding_acks acknowledgement
            ON acknowledgement."operationId" = requirement."operationId"
           AND acknowledgement."tenantId" = requirement."tenantId"
           AND acknowledgement.generation = requirement.generation
           AND acknowledgement.service = requirement.service
         WHERE requirement."operationId" = requested_operation_id
           AND requirement."tenantId" = requested_tenant_id
           AND requirement.generation = requested_generation
      $tenant_onboarding_evidence$;

      CREATE FUNCTION "admin"."seal_tenant_onboarding_activation"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER
      ) RETURNS TABLE (
        "sealToken" UUID, "generation" INTEGER, "evidenceRoot" TEXT,
        "publicationDigest" TEXT
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_activation_seal$
      DECLARE
        run_authority RECORD;
        current_evidence JSONB;
        current_root TEXT;
        publication_proof RECORD;
        requirement_count INTEGER;
        ack_count INTEGER;
      BEGIN
        SELECT * INTO run_authority
          FROM admin.tenant_provisioning_runs
         WHERE id = requested_operation_id AND "tenantId" = requested_tenant_id
         FOR UPDATE;
        IF NOT FOUND OR run_authority."onboardingQualification" <> 'QUALIFIED'
          OR run_authority."onboardingGeneration" <> requested_generation
          OR run_authority."onboardingSafetyFailure" IS NOT NULL
          OR run_authority."onboardingRequestedAt" IS NULL THEN
          RAISE EXCEPTION 'tenant onboarding activation authority is unavailable'
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO publication_proof
          FROM admin.assert_tenant_onboarding_publication(
            requested_operation_id, requested_tenant_id, requested_generation
          );
        current_evidence := admin.tenant_onboarding_evidence(
          requested_operation_id, requested_tenant_id, requested_generation
        );
        requirement_count := jsonb_array_length(
          run_authority."onboardingRequirements" -> 'requiredServices'
        );
        SELECT count(*) FILTER (
                 WHERE value ->> 'status' = 'ACK'
                   AND (value ->> 'acknowledgedAt')::timestamptz >= run_authority."onboardingRequestedAt"
                   AND (value ->> 'acknowledgedAt')::timestamptz <= run_authority."onboardingDeadlineAt"
               )
          INTO ack_count FROM jsonb_array_elements(current_evidence);
        IF jsonb_array_length(current_evidence) <> requirement_count
          OR ack_count <> requirement_count THEN
          RAISE EXCEPTION 'tenant onboarding activation barrier is not satisfied'
            USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM admin.tenant_provisioning_steps
           WHERE "runId" = requested_operation_id
             AND "stepName" = 'publish_onboarding_requested' AND state = 'SUCCEEDED'
        ) OR NOT EXISTS (
          SELECT 1 FROM admin.tenant_provisioning_steps
           WHERE "runId" = requested_operation_id
             AND "stepName" = 'wait_for_onboarding_ack' AND state = 'SUCCEEDED'
        ) THEN
          RAISE EXCEPTION 'tenant onboarding activation prerequisites are incomplete'
            USING ERRCODE = '23514';
        END IF;
        current_root := encode(public.digest(
          convert_to('tenant-onboarding-activation.v1', 'UTF8')
            || decode('00', 'hex')
            || convert_to(jsonb_build_object(
                 'publicationDigest', publication_proof."publicationDigest",
                 'evidence', current_evidence
               )::text, 'UTF8'),
          'sha256'
        ), 'hex');
        IF run_authority."onboardingSealToken" IS NULL THEN
          UPDATE admin.tenant_provisioning_runs
             SET "onboardingSealGeneration" = requested_generation,
                 "onboardingSealEvidence" = current_evidence,
                 "onboardingSealEvidenceRoot" = current_root,
                 "onboardingSealToken" = public.uuid_generate_v4(),
                 "updatedAt" = now()
           WHERE id = requested_operation_id
           RETURNING "onboardingSealToken", "onboardingGeneration",
                     "onboardingSealEvidenceRoot", "onboardingPublicationDigest"
                INTO "sealToken", "generation", "evidenceRoot", "publicationDigest";
        ELSE
          IF run_authority."onboardingSealEvidence" IS DISTINCT FROM current_evidence
            OR run_authority."onboardingSealEvidenceRoot" IS DISTINCT FROM current_root THEN
            RAISE EXCEPTION 'tenant onboarding evidence changed after activation seal'
              USING ERRCODE = '23514';
          END IF;
          "sealToken" := run_authority."onboardingSealToken";
          "generation" := run_authority."onboardingGeneration";
          "evidenceRoot" := run_authority."onboardingSealEvidenceRoot";
          "publicationDigest" := run_authority."onboardingPublicationDigest";
        END IF;
        RETURN NEXT;
      END
      $tenant_onboarding_activation_seal$;

      CREATE FUNCTION "admin"."consume_tenant_onboarding_activation"(
        requested_operation_id UUID,
        requested_tenant_id UUID,
        requested_generation INTEGER,
        requested_seal_token UUID,
        requested_evidence_root TEXT,
        requested_publication_digest TEXT
      ) RETURNS TABLE ("evidenceRoot" TEXT, "publicationDigest" TEXT)
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, admin
      AS $tenant_onboarding_activation_consume$
      DECLARE
        run_authority RECORD;
        current_evidence JSONB;
        current_root TEXT;
        publication_proof RECORD;
      BEGIN
        SELECT * INTO run_authority
          FROM admin.tenant_provisioning_runs
         WHERE id = requested_operation_id AND "tenantId" = requested_tenant_id
         FOR UPDATE;
        IF NOT FOUND OR run_authority."onboardingGeneration" <> requested_generation
          OR run_authority."onboardingSealGeneration" <> requested_generation
          OR run_authority."onboardingSealToken" <> requested_seal_token
          OR run_authority."onboardingSafetyFailure" IS NOT NULL
          OR run_authority."onboardingSealEvidenceRoot" <> requested_evidence_root
          OR run_authority."onboardingPublicationDigest" <> requested_publication_digest THEN
          RAISE EXCEPTION 'tenant onboarding activation proof is stale, unsafe, or inconsistent'
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO publication_proof
          FROM admin.assert_tenant_onboarding_publication(
            requested_operation_id, requested_tenant_id, requested_generation
          );
        current_evidence := admin.tenant_onboarding_evidence(
          requested_operation_id, requested_tenant_id, requested_generation
        );
        current_root := encode(public.digest(
          convert_to('tenant-onboarding-activation.v1', 'UTF8')
            || decode('00', 'hex')
            || convert_to(jsonb_build_object(
                 'publicationDigest', publication_proof."publicationDigest",
                 'evidence', current_evidence
               )::text, 'UTF8'),
          'sha256'
        ), 'hex');
        IF current_evidence IS DISTINCT FROM run_authority."onboardingSealEvidence"
          OR current_root IS DISTINCT FROM requested_evidence_root
          OR publication_proof."publicationDigest" IS DISTINCT FROM requested_publication_digest THEN
          RAISE EXCEPTION 'tenant onboarding activation evidence no longer equals its seal'
            USING ERRCODE = '23514';
        END IF;
        UPDATE admin.tenant_provisioning_runs
           SET "onboardingActivationConsumedAt" = COALESCE(
                 "onboardingActivationConsumedAt", now()
               ), "updatedAt" = now()
         WHERE id = requested_operation_id;
        "evidenceRoot" := current_root;
        "publicationDigest" := publication_proof."publicationDigest";
        RETURN NEXT;
      END
      $tenant_onboarding_activation_consume$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION admin.guard_tenant_onboarding_legacy_archive() FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.guard_tenant_onboarding_requirement() FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.guard_tenant_onboarding_authority() FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.guard_tenant_onboarding_ack_immutability() FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.assert_tenant_onboarding_publication(
        UUID, UUID, INTEGER
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.publish_tenant_onboarding_request(
        UUID, UUID, INTEGER, JSONB
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.admit_tenant_onboarding_outcome(
        UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.tenant_onboarding_evidence(
        UUID, UUID, INTEGER
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.seal_tenant_onboarding_activation(
        UUID, UUID, INTEGER
      ) FROM PUBLIC;
      REVOKE ALL ON FUNCTION admin.consume_tenant_onboarding_activation(
        UUID, UUID, INTEGER, UUID, TEXT, TEXT
      ) FROM PUBLIC;

      DO $tenant_onboarding_grants$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') THEN
          GRANT USAGE ON SCHEMA admin TO admin_service;
          REVOKE ALL ON TABLE admin.tenant_onboarding_acks FROM admin_service;
          REVOKE ALL ON TABLE admin.tenant_onboarding_acks_legacy FROM admin_service;
          REVOKE ALL ON TABLE admin.tenant_onboarding_requirements FROM admin_service;
          GRANT SELECT ON TABLE admin.tenant_onboarding_acks,
            admin.tenant_onboarding_acks_legacy TO admin_service;
          GRANT SELECT, INSERT ON TABLE admin.tenant_onboarding_requirements TO admin_service;
          GRANT EXECUTE ON FUNCTION admin.publish_tenant_onboarding_request(
            UUID, UUID, INTEGER, JSONB
          ) TO admin_service;
          GRANT EXECUTE ON FUNCTION admin.assert_tenant_onboarding_publication(
            UUID, UUID, INTEGER
          ) TO admin_service;
          GRANT EXECUTE ON FUNCTION admin.admit_tenant_onboarding_outcome(
            UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ
          ) TO admin_service;
          GRANT EXECUTE ON FUNCTION admin.seal_tenant_onboarding_activation(
            UUID, UUID, INTEGER
          ) TO admin_service;
          REVOKE ALL ON FUNCTION admin.consume_tenant_onboarding_activation(
            UUID, UUID, INTEGER, UUID, TEXT, TEXT
          ) FROM admin_service;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_service') THEN
          GRANT USAGE ON SCHEMA admin TO auth_service;
          REVOKE ALL ON FUNCTION admin.publish_tenant_onboarding_request(
            UUID, UUID, INTEGER, JSONB
          ) FROM auth_service;
          REVOKE ALL ON FUNCTION admin.assert_tenant_onboarding_publication(
            UUID, UUID, INTEGER
          ) FROM auth_service;
          REVOKE ALL ON FUNCTION admin.admit_tenant_onboarding_outcome(
            UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ
          ) FROM auth_service;
          REVOKE ALL ON FUNCTION admin.seal_tenant_onboarding_activation(
            UUID, UUID, INTEGER
          ) FROM auth_service;
          GRANT EXECUTE ON FUNCTION admin.consume_tenant_onboarding_activation(
            UUID, UUID, INTEGER, UUID, TEXT, TEXT
          ) TO auth_service;
        END IF;
      END
      $tenant_onboarding_grants$
    `);
  }

  public async down(): Promise<void> {
    throw new Error(ROLLBACK_REFUSAL);
  }
}
