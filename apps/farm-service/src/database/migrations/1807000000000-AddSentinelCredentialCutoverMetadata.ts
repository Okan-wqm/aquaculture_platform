import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expands the retained tenant-local Sentinel credential table with durable
 * cutover provenance. The runtime credential path is config-service only; a
 * bootstrap cutover worker marks a legacy row only after the complete atomic
 * CDSE bundle has been accepted by config-service.
 */
export class AddSentinelCredentialCutoverMetadata1807000000000 implements MigrationInterface {
  name = 'AddSentinelCredentialCutoverMetadata1807000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "sentinel_hub_settings"
        ADD COLUMN IF NOT EXISTS "config_cutover_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "config_cutover_bundle_digest" varchar(64),
        ADD COLUMN IF NOT EXISTS "config_cutover_version" integer,
        ADD COLUMN IF NOT EXISTS "config_cutover_source_tenant_id" uuid,
        ADD COLUMN IF NOT EXISTS "config_cutover_erased_at" timestamptz
    `);

    await queryRunner.query(`
      UPDATE "sentinel_hub_settings"
         SET "client_id" = NULL,
             "client_secret" = NULL,
             "instance_id" = NULL,
             "updated_at" = now()
       WHERE "is_configured" = false
         AND (
           "client_id" IS NOT NULL
           OR "client_secret" IS NOT NULL
           OR "instance_id" IS NOT NULL
         )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_constraint
           WHERE conname = 'CHK_sentinel_hub_settings_config_cutover_complete'
             AND conrelid = 'sentinel_hub_settings'::regclass
        ) THEN
          ALTER TABLE "sentinel_hub_settings"
            ADD CONSTRAINT "CHK_sentinel_hub_settings_config_cutover_complete"
            CHECK (
              (
                "config_cutover_bundle_digest" IS NULL
                AND
                "config_cutover_at" IS NULL
                AND "config_cutover_version" IS NULL
                AND "config_cutover_source_tenant_id" IS NULL
                AND "config_cutover_erased_at" IS NULL
                AND (
                  "is_configured" = true
                  OR (
                    "client_id" IS NULL
                    AND "client_secret" IS NULL
                    AND "instance_id" IS NULL
                  )
                )
              )
              OR (
                "config_cutover_bundle_digest" ~ '^[a-f0-9]{64}$'
                AND "config_cutover_at" IS NULL
                AND "config_cutover_version" IS NULL
                AND "config_cutover_source_tenant_id" IS NULL
                AND "config_cutover_erased_at" IS NULL
                AND "is_configured" = true
              )
              OR (
                "config_cutover_bundle_digest" ~ '^[a-f0-9]{64}$'
                AND
                "config_cutover_at" IS NOT NULL
                AND "config_cutover_version" > 0
                AND "config_cutover_source_tenant_id" = "tenantId"
                AND "config_cutover_erased_at" IS NULL
                AND "is_configured" = false
                AND "client_id" IS NULL
                AND "client_secret" IS NULL
                AND "instance_id" IS NULL
              )
              OR (
                "config_cutover_bundle_digest" ~ '^[a-f0-9]{64}$'
                AND "config_cutover_at" IS NULL
                AND "config_cutover_version" IS NULL
                AND "config_cutover_source_tenant_id" IS NULL
                AND "config_cutover_erased_at" IS NOT NULL
                AND "is_configured" = false
                AND "client_id" IS NULL
                AND "client_secret" IS NULL
                AND "instance_id" IS NULL
              )
            );
        END IF;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "prevent_sentinel_hub_credential_reactivation"()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $$
      DECLARE
        erasure_tenant text;
        scoped_tenant text;
        erasure_operation text;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          erasure_tenant := pg_catalog.current_setting(
            'app.tenant_erasure_tenant_id', true
          );
          scoped_tenant := pg_catalog.current_setting('app.current_tenant', true);
          erasure_operation := pg_catalog.current_setting(
            'app.tenant_erasure_operation_id', true
          );
          IF pg_catalog.current_setting(
               'app.tenant_erasure_target_service', true
             ) = 'farm-service'
             AND erasure_tenant
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND scoped_tenant
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND erasure_operation
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            IF erasure_tenant::uuid = OLD."tenantId"
               AND scoped_tenant::uuid = OLD."tenantId"
               AND EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_locks AS held_lock
                  WHERE held_lock.locktype = 'advisory'
                    AND held_lock.pid = pg_catalog.pg_backend_pid()
                    AND held_lock.classid =
                        pg_catalog.hashtext('farm-service:sentinel-erasure:v1')::oid
                    AND held_lock.objid =
                        pg_catalog.hashtext(erasure_operation)::oid
                    AND held_lock.objsubid = 2
                    AND held_lock.mode = 'ExclusiveLock'
                    AND held_lock.granted
               ) THEN
              RETURN OLD;
            END IF;
          END IF;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Sentinel credential rows may only be deleted by authorized tenant erasure';
        END IF;

        IF OLD."config_cutover_bundle_digest" IS NOT NULL
           AND OLD."config_cutover_at" IS NULL
           AND OLD."config_cutover_erased_at" IS NULL THEN
          IF NOT (
            (
              NEW."config_cutover_bundle_digest" = OLD."config_cutover_bundle_digest"
              AND NEW."config_cutover_at" IS NOT NULL
              AND NEW."config_cutover_version" > 0
              AND NEW."config_cutover_source_tenant_id" = OLD."tenantId"
              AND NEW."config_cutover_erased_at" IS NULL
              AND NEW."tenantId" = OLD."tenantId"
              AND NEW."is_configured" = false
              AND NEW."client_id" IS NULL
              AND NEW."client_secret" IS NULL
              AND NEW."instance_id" IS NULL
            )
            OR
            (
              NEW."config_cutover_bundle_digest" = OLD."config_cutover_bundle_digest"
              AND NEW."config_cutover_at" IS NULL
              AND NEW."config_cutover_version" IS NULL
              AND NEW."config_cutover_source_tenant_id" IS NULL
              AND NEW."config_cutover_erased_at" IS NOT NULL
              AND NEW."tenantId" = OLD."tenantId"
              AND NEW."is_configured" = false
              AND NEW."client_id" IS NULL
              AND NEW."client_secret" IS NULL
              AND NEW."instance_id" IS NULL
            )
          ) THEN
            RAISE EXCEPTION 'prepared Sentinel credential bundle is immutable until cutover completes';
          END IF;
        ELSIF OLD."config_cutover_at" IS NOT NULL
              OR OLD."config_cutover_erased_at" IS NOT NULL THEN
          IF NEW."config_cutover_at" IS DISTINCT FROM OLD."config_cutover_at"
             OR NEW."config_cutover_version" IS DISTINCT FROM OLD."config_cutover_version"
             OR NEW."config_cutover_source_tenant_id"
                IS DISTINCT FROM OLD."config_cutover_source_tenant_id"
             OR NEW."config_cutover_bundle_digest"
                IS DISTINCT FROM OLD."config_cutover_bundle_digest"
             OR NEW."config_cutover_erased_at"
                IS DISTINCT FROM OLD."config_cutover_erased_at"
             OR NEW."is_configured" = true
             OR NEW."client_id" IS NOT NULL
             OR NEW."client_secret" IS NOT NULL
             OR NEW."instance_id" IS NOT NULL THEN
            RAISE EXCEPTION 'cut-over Sentinel credentials cannot be reactivated';
          END IF;
        ELSIF NEW."config_cutover_bundle_digest" IS NOT NULL THEN
          IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
             OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
             OR NEW."client_secret" IS DISTINCT FROM OLD."client_secret"
             OR NEW."instance_id" IS DISTINCT FROM OLD."instance_id"
             OR NEW."is_configured" IS DISTINCT FROM OLD."is_configured"
             OR NEW."config_cutover_at" IS NOT NULL
             OR NEW."config_cutover_version" IS NOT NULL
             OR NEW."config_cutover_source_tenant_id" IS NOT NULL
             OR NEW."config_cutover_erased_at" IS NOT NULL THEN
            RAISE EXCEPTION 'Sentinel credential preparation may only freeze the current bundle';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_prevent_sentinel_hub_credential_reactivation"
        ON "sentinel_hub_settings"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_prevent_sentinel_hub_credential_reactivation"
      BEFORE UPDATE OR DELETE ON "sentinel_hub_settings"
      FOR EACH ROW
      EXECUTE FUNCTION "prevent_sentinel_hub_credential_reactivation"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    // A successful cutover deliberately destroys the duplicate tenant-local
    // ciphertext. Removing its provenance cannot restore those secrets, so a
    // rollback after activation would silently turn a completed migration into
    // an indistinguishable unconfigured row. Fail before changing any object.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "sentinel_hub_settings"
          WHERE "config_cutover_bundle_digest" IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'cannot roll back Sentinel credential cutover metadata after preparation started';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_prevent_sentinel_hub_credential_reactivation"
        ON "sentinel_hub_settings"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "prevent_sentinel_hub_credential_reactivation"()
    `);

    await queryRunner.query(`
      ALTER TABLE "sentinel_hub_settings"
        DROP CONSTRAINT IF EXISTS "CHK_sentinel_hub_settings_config_cutover_complete",
        DROP COLUMN IF EXISTS "config_cutover_source_tenant_id",
        DROP COLUMN IF EXISTS "config_cutover_version",
        DROP COLUMN IF EXISTS "config_cutover_bundle_digest",
        DROP COLUMN IF EXISTS "config_cutover_erased_at",
        DROP COLUMN IF EXISTS "config_cutover_at"
    `);
  }
}
