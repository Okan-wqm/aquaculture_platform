import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
const FORECAST = FEEDING_MIGRATION_AUTHORITY_V1.forecastProjection;
const GENERATION = FORECAST.generation;

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Introduces immutable forecast generations without guessing or deleting the
 * pre-contract projection. Legacy rows are byte-preserved in quarantine and
 * attached to a RETIRED generation; readers remain empty until the canonical
 * refresh operation qualifies and atomically activates an exact replacement.
 */
export class CompileForecastPoolAuthority1809600000000 implements MigrationInterface {
  name = 'CompileForecastPoolAuthority1809600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    const presence: Array<{ snapshots: string | null }> = await queryRunner.query(
      `SELECT to_regclass(${literal(GENERATION.snapshotRelation)})::text AS snapshots`,
    );
    if (!presence[0]?.snapshots) return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${GENERATION.legacyQuarantineRelation}" (
        "snapshotId" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "originalCanonicalJson" text NOT NULL,
        "originalSnapshot" jsonb NOT NULL,
        "originalDigest" char(64) NOT NULL,
        "quarantinedAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
        reason varchar(64) NOT NULL DEFAULT 'PRE_GENERATION_SEMANTICS',
        CONSTRAINT "CHK_ffs_legacy_digest_shape" CHECK ("originalDigest" ~ '^[0-9a-f]{64}$')
      )
    `);
    const generationColumn: Array<{ installed: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = ${literal(GENERATION.snapshotRelation)}
           AND column_name = 'generationId'
      ) AS installed
    `);
    if (generationColumn[0]?.installed !== true) {
      await queryRunner.query(`
        INSERT INTO "${GENERATION.legacyQuarantineRelation}"
          ("snapshotId", "tenantId", "originalCanonicalJson", "originalSnapshot", "originalDigest")
        SELECT snapshot.id, snapshot."tenantId", to_jsonb(snapshot)::text, to_jsonb(snapshot),
               encode(pg_catalog.sha256(convert_to(to_jsonb(snapshot)::text, 'UTF8')), 'hex')
          FROM "${GENERATION.snapshotRelation}" snapshot
        ON CONFLICT ("snapshotId") DO NOTHING
      `);
      const invalidQuarantine: Array<{ count: string }> = await queryRunner.query(`
        SELECT COUNT(*)::text AS count
          FROM "${GENERATION.snapshotRelation}" snapshot
          LEFT JOIN "${GENERATION.legacyQuarantineRelation}" quarantine
            ON quarantine."snapshotId" = snapshot.id
         WHERE quarantine."snapshotId" IS NULL
            OR quarantine."tenantId" <> snapshot."tenantId"
            OR quarantine."originalCanonicalJson" <> to_jsonb(snapshot)::text
            OR quarantine."originalSnapshot" <> to_jsonb(snapshot)
            OR quarantine."originalDigest" <>
               encode(pg_catalog.sha256(convert_to(to_jsonb(snapshot)::text, 'UTF8')), 'hex')
      `);
      if (invalidQuarantine[0]?.count !== '0') {
        throw new Error('Forecast legacy quarantine differs from the preserved snapshot set');
      }
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${GENERATION.generationRelation}" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "operationId" varchar(160) NOT NULL,
        state varchar(10) NOT NULL,
        "catalogRevision" varchar(64) NOT NULL,
        "catalogDigest" char(64) NOT NULL,
        "sourceWatermark" timestamptz NOT NULL,
        "exactSetDigest" char(64) NOT NULL,
        "membershipDigest" char(64) NOT NULL,
        "snapshotCount" integer NOT NULL,
        "previousActiveGenerationId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT statement_timestamp(),
        "qualifiedAt" timestamptz,
        "activatedAt" timestamptz,
        "retiredAt" timestamptz,
        CONSTRAINT "UQ_ffs_generation_tenant_id" UNIQUE ("tenantId", id),
        CONSTRAINT "UQ_ffs_generation_operation" UNIQUE ("tenantId", "operationId"),
        CONSTRAINT "CHK_ffs_generation_state" CHECK (
          state IN ('BUILDING', 'QUALIFIED', 'ACTIVE', 'RETIRED')
        ),
        CONSTRAINT "CHK_ffs_generation_digest_shape" CHECK (
          "catalogDigest" ~ '^[0-9a-f]{64}$'
          AND "exactSetDigest" ~ '^[0-9a-f]{64}$'
          AND "membershipDigest" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "CHK_ffs_generation_count" CHECK ("snapshotCount" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ffs_generation_one_active"
        ON "${GENERATION.generationRelation}" ("tenantId") WHERE state = 'ACTIVE'
    `);

    await queryRunner.query(`
      ALTER TABLE "${GENERATION.snapshotRelation}"
        ADD COLUMN IF NOT EXISTS "poolScope" varchar(8),
        ADD COLUMN IF NOT EXISTS "generationId" uuid,
        ADD COLUMN IF NOT EXISTS "payloadDigest" char(64)
    `);
    await queryRunner.query(`
      INSERT INTO "${GENERATION.generationRelation}"
        (id, "tenantId", "operationId", state, "catalogRevision", "catalogDigest",
         "sourceWatermark", "exactSetDigest", "membershipDigest", "snapshotCount",
         "createdAt", "qualifiedAt", "activatedAt", "retiredAt")
      SELECT gen_random_uuid(), quarantine."tenantId",
             'migration/180960/legacy/' || quarantine."tenantId"::text,
             'RETIRED', ${literal(GENERATION.schemaVersion)}, ${literal(GENERATION.catalogDigest)},
             MIN(quarantine."quarantinedAt"),
             encode(pg_catalog.sha256(convert_to(COALESCE(string_agg(
               quarantine."snapshotId"::text || ':' || quarantine."originalDigest",
               E'\\n' ORDER BY quarantine."snapshotId"
             ), ''), 'UTF8')), 'hex'),
             encode(pg_catalog.sha256(convert_to(COALESCE(string_agg(
               length(snapshot."siteScopeKey")::text || ':' || snapshot."siteScopeKey" ||
               '|0:|' || quarantine."originalDigest",
               E'\\n' ORDER BY snapshot."siteScopeKey" COLLATE "C"
             ), ''), 'UTF8')), 'hex'),
             COUNT(*)::integer,
             MIN(quarantine."quarantinedAt"), MIN(quarantine."quarantinedAt"),
             MIN(quarantine."quarantinedAt"), MIN(quarantine."quarantinedAt")
        FROM "${GENERATION.legacyQuarantineRelation}" quarantine
        JOIN "${GENERATION.snapshotRelation}" snapshot ON snapshot.id = quarantine."snapshotId"
       GROUP BY quarantine."tenantId"
      ON CONFLICT ("tenantId", "operationId") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "${GENERATION.snapshotRelation}" snapshot
         SET "generationId" = generation.id,
             "payloadDigest" = quarantine."originalDigest"
        FROM "${GENERATION.legacyQuarantineRelation}" quarantine,
             "${GENERATION.generationRelation}" generation
       WHERE quarantine."snapshotId" = snapshot.id
         AND generation."tenantId" = snapshot."tenantId"
         AND generation."operationId" =
             'migration/180960/legacy/' || snapshot."tenantId"::text
         AND snapshot."generationId" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "${GENERATION.snapshotRelation}"
        ALTER COLUMN "generationId" SET NOT NULL,
        ALTER COLUMN "payloadDigest" SET NOT NULL,
        DROP CONSTRAINT IF EXISTS "CHK_ffs_pool_scope_v1",
        DROP CONSTRAINT IF EXISTS "CHK_ffs_pool_identity_v1",
        DROP CONSTRAINT IF EXISTS "CHK_ffs_payload_digest_shape",
        DROP CONSTRAINT IF EXISTS "FK_ffs_snapshot_generation"
    `);
    await queryRunner.query(`
      ALTER TABLE "${GENERATION.snapshotRelation}"
        ADD CONSTRAINT "CHK_ffs_pool_scope_v1"
          CHECK ("poolScope" IS NULL OR "poolScope" IN ('TENANT', 'SITE')),
        ADD CONSTRAINT "CHK_ffs_pool_identity_v1"
          CHECK (
            "poolScope" IS NULL OR
            (("siteScopeKey" = ${literal(FORECAST.tenantScopeKey)}) = ("poolScope" = 'TENANT'))
          ),
        ADD CONSTRAINT "CHK_ffs_payload_digest_shape"
          CHECK ("payloadDigest" ~ '^[0-9a-f]{64}$'),
        ADD CONSTRAINT "FK_ffs_snapshot_generation" FOREIGN KEY ("tenantId", "generationId")
          REFERENCES "${GENERATION.generationRelation}" ("tenantId", id) ON DELETE CASCADE
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ffs_tenant_scope"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_feeding_forecast_snapshots_tenant_scope"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ffs_generation_scope"
        ON "${GENERATION.snapshotRelation}" ("tenantId", "generationId", "siteScopeKey")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${GENERATION.activePointerRelation}" (
        "tenantId" uuid PRIMARY KEY,
        "generationId" uuid NOT NULL,
        revision bigint NOT NULL DEFAULT 1,
        "activatedAt" timestamptz NOT NULL,
        CONSTRAINT "FK_ffs_active_generation" FOREIGN KEY ("tenantId", "generationId")
          REFERENCES "${GENERATION.generationRelation}" ("tenantId", id) ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION assert_feeding_forecast_generation_transition_v1()
      RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        IF ROW(OLD.id, OLD."tenantId", OLD."operationId", OLD."catalogRevision",
               OLD."catalogDigest", OLD."sourceWatermark", OLD."exactSetDigest",
               OLD."membershipDigest", OLD."snapshotCount", OLD."previousActiveGenerationId",
               OLD."createdAt")
           IS DISTINCT FROM
           ROW(NEW.id, NEW."tenantId", NEW."operationId", NEW."catalogRevision",
               NEW."catalogDigest", NEW."sourceWatermark", NEW."exactSetDigest",
               NEW."membershipDigest", NEW."snapshotCount", NEW."previousActiveGenerationId",
               NEW."createdAt") THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'forecast generation immutable coordinates cannot change';
        END IF;
        IF OLD.state = NEW.state THEN
          IF OLD IS DISTINCT FROM NEW THEN
            RAISE EXCEPTION USING ERRCODE = '55000',
              MESSAGE = 'forecast generation can change only through a typed transition';
          END IF;
          RETURN NEW;
        END IF;
        IF NOT (
          (OLD.state = 'BUILDING' AND NEW.state = 'QUALIFIED') OR
          (OLD.state = 'QUALIFIED' AND NEW.state = 'ACTIVE') OR
          (OLD.state = 'ACTIVE' AND NEW.state = 'RETIRED')
        ) OR
        (OLD.state = 'BUILDING' AND (
          NEW."qualifiedAt" IS NULL OR NEW."activatedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL
        )) OR
        (OLD.state = 'QUALIFIED' AND (
          NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt" OR NEW."activatedAt" IS NULL
          OR NEW."retiredAt" IS NOT NULL
        )) OR
        (OLD.state = 'ACTIVE' AND (
          NEW."qualifiedAt" IS DISTINCT FROM OLD."qualifiedAt"
          OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR NEW."retiredAt" IS NULL
        )) THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'illegal forecast generation transition';
        END IF;
        RETURN NEW;
      END
      $function$;
      DROP TRIGGER IF EXISTS "TRG_ffs_generation_transition"
        ON "${GENERATION.generationRelation}";
      CREATE TRIGGER "TRG_ffs_generation_transition"
        BEFORE UPDATE ON "${GENERATION.generationRelation}"
        FOR EACH ROW EXECUTE FUNCTION assert_feeding_forecast_generation_transition_v1()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${GENERATION.mutationFunctions.qualify}(
        p_tenant_id uuid,
        p_generation_id uuid,
        p_exact_set_digest text,
        p_membership_digest text,
        p_snapshot_count integer,
        p_qualified_at timestamptz
      ) RETURNS void
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE
        authority "${GENERATION.generationRelation}"%ROWTYPE;
        observed_count integer;
        invalid_count integer;
        observed_membership text;
      BEGIN
        SELECT * INTO authority
          FROM "${GENERATION.generationRelation}"
         WHERE "tenantId" = p_tenant_id AND id = p_generation_id
         FOR UPDATE;
        IF NOT FOUND OR authority.state <> 'BUILDING' THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'forecast generation is not BUILDING';
        END IF;
        SELECT COUNT(*)::integer,
               COUNT(*) FILTER (WHERE "poolScope" IS NULL)::integer,
               encode(pg_catalog.sha256(convert_to(COALESCE(string_agg(
                 length("siteScopeKey")::text || ':' || "siteScopeKey" || '|' ||
                 length("poolScope")::text || ':' || "poolScope" || '|' || "payloadDigest",
                 E'\\n' ORDER BY "siteScopeKey" COLLATE "C"
               ), ''), 'UTF8')), 'hex')
          INTO observed_count, invalid_count, observed_membership
          FROM "${GENERATION.snapshotRelation}"
         WHERE "tenantId" = p_tenant_id AND "generationId" = p_generation_id;
        IF authority."catalogRevision" <> ${literal(GENERATION.schemaVersion)}
           OR authority."catalogDigest" <> ${literal(GENERATION.catalogDigest)}
           OR authority."exactSetDigest" <> p_exact_set_digest
           OR authority."membershipDigest" <> p_membership_digest
           OR authority."snapshotCount" <> p_snapshot_count
           OR observed_count <> p_snapshot_count
           OR invalid_count <> 0
           OR observed_membership <> p_membership_digest THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'forecast generation exact-set qualification failed';
        END IF;
        UPDATE "${GENERATION.generationRelation}"
           SET state = 'QUALIFIED', "qualifiedAt" = p_qualified_at
         WHERE "tenantId" = p_tenant_id AND id = p_generation_id;
      END
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${GENERATION.mutationFunctions.activate}(
        p_tenant_id uuid,
        p_generation_id uuid,
        p_expected_active_generation_id uuid,
        p_activated_at timestamptz
      ) RETURNS bigint
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE
        observed_active uuid;
        next_revision bigint;
        changed integer;
      BEGIN
        SELECT "generationId" INTO observed_active
          FROM "${GENERATION.activePointerRelation}"
         WHERE "tenantId" = p_tenant_id;
        IF observed_active IS DISTINCT FROM p_expected_active_generation_id THEN
          RAISE EXCEPTION USING ERRCODE = '40001',
            MESSAGE = 'forecast active generation compare-and-swap failed';
        END IF;

        IF observed_active IS NULL THEN
          INSERT INTO "${GENERATION.activePointerRelation}"
            ("tenantId", "generationId", revision, "activatedAt")
          VALUES (p_tenant_id, p_generation_id, 1, p_activated_at)
          ON CONFLICT ("tenantId") DO NOTHING;
          GET DIAGNOSTICS changed = ROW_COUNT;
          IF changed <> 1 THEN
            RAISE EXCEPTION USING ERRCODE = '40001',
              MESSAGE = 'forecast active generation compare-and-swap failed';
          END IF;
          next_revision := 1;
        ELSE
          UPDATE "${GENERATION.activePointerRelation}"
             SET "generationId" = p_generation_id,
                 revision = revision + 1,
                 "activatedAt" = p_activated_at
           WHERE "tenantId" = p_tenant_id AND "generationId" = observed_active
          RETURNING revision INTO next_revision;
          IF next_revision IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '40001',
              MESSAGE = 'forecast active generation compare-and-swap failed';
          END IF;
          UPDATE "${GENERATION.generationRelation}"
             SET state = 'RETIRED', "retiredAt" = p_activated_at
           WHERE "tenantId" = p_tenant_id AND id = observed_active AND state = 'ACTIVE';
          GET DIAGNOSTICS changed = ROW_COUNT;
          IF changed <> 1 THEN
            RAISE EXCEPTION USING ERRCODE = '55000',
              MESSAGE = 'forecast previous active generation is inconsistent';
          END IF;
        END IF;

        UPDATE "${GENERATION.generationRelation}"
           SET state = 'ACTIVE', "activatedAt" = p_activated_at
         WHERE "tenantId" = p_tenant_id AND id = p_generation_id AND state = 'QUALIFIED';
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'forecast replacement generation is not QUALIFIED';
        END IF;
        RETURN next_revision;
      END
      $function$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${GENERATION.mutationFunctions.purgeRetired}(
        p_tenant_id uuid,
        p_cutoff timestamptz
      ) RETURNS bigint
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      DECLARE
        active_generation_id uuid;
        deleted_snapshot_count bigint;
      BEGIN
        IF p_cutoff IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22004',
            MESSAGE = 'forecast retention cutoff is required';
        END IF;
        SELECT "generationId" INTO active_generation_id
          FROM "${GENERATION.activePointerRelation}"
         WHERE "tenantId" = p_tenant_id
         FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 0;
        END IF;
        WITH deleted AS (
          DELETE FROM "${GENERATION.generationRelation}" generation
           WHERE generation."tenantId" = p_tenant_id
             AND generation.state = 'RETIRED'
             AND generation."sourceWatermark" < p_cutoff
             AND generation.id <> active_generation_id
          RETURNING generation."snapshotCount"
        )
        SELECT COALESCE(SUM("snapshotCount"), 0)
          INTO deleted_snapshot_count
          FROM deleted;
        RETURN deleted_snapshot_count;
      END
      $function$;
      REVOKE ALL ON FUNCTION ${GENERATION.mutationFunctions.purgeRetired}(
        uuid, timestamptz
      ) FROM PUBLIC
    `);
    await queryRunner.query(`
      DO $roles$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          GRANT EXECUTE ON FUNCTION ${GENERATION.mutationFunctions.purgeRetired}(
            uuid, timestamptz
          ) TO farm_service;
        END IF;
      END
      $roles$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE VIEW "${GENERATION.activeProjection}"
      WITH (security_barrier = true, security_invoker = true) AS
      SELECT snapshot.*
        FROM "${GENERATION.snapshotRelation}" snapshot
        JOIN "${GENERATION.activePointerRelation}" active
          ON active."tenantId" = snapshot."tenantId"
         AND active."generationId" = snapshot."generationId"
        JOIN "${GENERATION.generationRelation}" generation
          ON generation."tenantId" = active."tenantId"
         AND generation.id = active."generationId"
       WHERE generation.state = 'ACTIVE'
         AND generation."catalogRevision" = ${literal(GENERATION.schemaVersion)}
         AND generation."catalogDigest" = ${literal(GENERATION.catalogDigest)}
         AND snapshot."poolScope" IS NOT NULL
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT (
        to_regclass(${literal(GENERATION.generationRelation)}) IS NOT NULL
        AND to_regclass(${literal(GENERATION.activePointerRelation)}) IS NOT NULL
        AND to_regclass(${literal(GENERATION.activeProjection)}) IS NOT NULL
        AND to_regclass(${literal(GENERATION.legacyQuarantineRelation)}) IS NOT NULL
        AND to_regprocedure(${literal(`${GENERATION.mutationFunctions.qualify}(uuid,uuid,text,text,integer,timestamp with time zone)`)}) IS NOT NULL
        AND to_regprocedure(${literal(`${GENERATION.mutationFunctions.activate}(uuid,uuid,uuid,timestamp with time zone)`)}) IS NOT NULL
        AND to_regprocedure(${literal(`${GENERATION.mutationFunctions.purgeRetired}(uuid,timestamp with time zone)`)}) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "${GENERATION.snapshotRelation}"
          WHERE "generationId" IS NULL OR "payloadDigest" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "${GENERATION.snapshotRelation}" snapshot
          LEFT JOIN "${GENERATION.legacyQuarantineRelation}" quarantine
            ON quarantine."snapshotId" = snapshot.id
          JOIN "${GENERATION.generationRelation}" generation
            ON generation.id = snapshot."generationId"
           AND generation."tenantId" = snapshot."tenantId"
          WHERE generation."operationId" LIKE 'migration/180960/legacy/%'
            AND (quarantine."snapshotId" IS NULL OR quarantine."originalDigest" <> snapshot."payloadDigest")
        )
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: active pointers and preserved legacy bytes are durable authority state.
  }
}
