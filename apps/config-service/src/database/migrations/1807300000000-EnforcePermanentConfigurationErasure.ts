import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repairs the historical FORCE-RLS erasure failure mode.
 *
 * Older generic target executors did not own app.current_tenant in their NATS
 * transaction. PostgreSQL therefore hid tenant rows, allowing a zero-count
 * proof to commit while configuration ciphertext survived. The fixed executor
 * pins and verifies RLS for future operations; this forward-only remediation
 * deletes any residual rows covered by an existing non-dry config-service
 * proof so those historical proofs cannot become write tombstones over live
 * secrets.
 */
export class EnforcePermanentConfigurationErasure1807300000000 implements MigrationInterface {
  name = 'EnforcePermanentConfigurationErasure1807300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF current_setting('app.bypass_rls', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'config erasure residual repair could not acquire RLS authority';
        END IF;
      END
      $$
    `);

    // Drain old application writers and keep both tables write-locked until
    // the trigger installation + purge + postcondition commit atomically.
    await queryRunner.query(`
      LOCK TABLE
        "config"."configuration_history",
        "config"."configurations",
        "config"."tenant_erasure_target_proofs"
      IN SHARE ROW EXCLUSIVE MODE
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "config"."reject_erased_tenant_configuration_write"()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, config
      AS $$
      BEGIN
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtext(
            'tenant-erasure-fence-v1:config-service:' || NEW."tenant_id"::text
          )
        );
        IF EXISTS (
          SELECT 1
            FROM "config"."tenant_erasure_target_proofs" AS proof
           WHERE proof."tenantId" = NEW."tenant_id"
             AND proof."targetService" = 'config-service'
             AND proof."dryRun" = false
        ) THEN
          RAISE EXCEPTION
            'configuration write rejected because tenant erasure is permanent'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION "config"."reject_erased_tenant_configuration_write"()
        FROM PUBLIC
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_reject_erased_tenant_configuration_write"
        ON "config"."configurations"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_reject_erased_tenant_configuration_write"
      BEFORE INSERT OR UPDATE ON "config"."configurations"
      FOR EACH ROW
      EXECUTE FUNCTION "config"."reject_erased_tenant_configuration_write"()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_reject_erased_tenant_configuration_history_write"
        ON "config"."configuration_history"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_reject_erased_tenant_configuration_history_write"
      BEFORE INSERT OR UPDATE ON "config"."configuration_history"
      FOR EACH ROW
      EXECUTE FUNCTION "config"."reject_erased_tenant_configuration_write"()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "config"."reject_unverified_config_erasure_proof"()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, config
      AS $$
      DECLARE
        pinned_tenant text;
      BEGIN
        IF NEW."targetService" <> 'config-service' THEN
          RETURN NEW;
        END IF;
        pinned_tenant := current_setting('app.current_tenant', true);
        IF pinned_tenant IS NULL
           OR pinned_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION
            'config erasure proof rejected because tenant RLS scope is unverified'
            USING ERRCODE = '55000';
        END IF;
        IF pinned_tenant::uuid IS DISTINCT FROM NEW."tenantId"
           OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off' THEN
          RAISE EXCEPTION
            'config erasure proof rejected because tenant RLS scope is unverified'
            USING ERRCODE = '55000';
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtext(
            'tenant-erasure-fence-v1:config-service:' || NEW."tenantId"::text
          )
        );
        IF NOT NEW."dryRun" AND (
          EXISTS (
            SELECT 1
              FROM "config"."configurations" AS configuration
             WHERE configuration."tenant_id" = NEW."tenantId"
          )
          OR EXISTS (
            SELECT 1
              FROM "config"."configuration_history" AS history
             WHERE history."tenant_id" = NEW."tenantId"
          )
        ) THEN
          RAISE EXCEPTION
            'config erasure proof rejected because tenant rows remain'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION "config"."reject_unverified_config_erasure_proof"()
        FROM PUBLIC
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_reject_unverified_config_erasure_proof"
        ON "config"."tenant_erasure_target_proofs"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_reject_unverified_config_erasure_proof"
      BEFORE INSERT OR UPDATE ON "config"."tenant_erasure_target_proofs"
      FOR EACH ROW
      EXECUTE FUNCTION "config"."reject_unverified_config_erasure_proof"()
    `);

    await queryRunner.query(`
      DELETE FROM "config"."configuration_history" AS history
      USING (
        SELECT DISTINCT proof."tenantId" AS tenant_id
          FROM "config"."tenant_erasure_target_proofs" AS proof
         WHERE proof."targetService" = 'config-service'
           AND proof."dryRun" = false
      ) AS erased
      WHERE history."tenant_id" = erased.tenant_id
    `);
    await queryRunner.query(`
      DELETE FROM "config"."configurations" AS configuration
      USING (
        SELECT DISTINCT proof."tenantId" AS tenant_id
          FROM "config"."tenant_erasure_target_proofs" AS proof
         WHERE proof."targetService" = 'config-service'
           AND proof."dryRun" = false
      ) AS erased
      WHERE configuration."tenant_id" = erased.tenant_id
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM "config"."tenant_erasure_target_proofs" AS proof
            JOIN "config"."configurations" AS configuration
              ON configuration."tenant_id" = proof."tenantId"
           WHERE proof."targetService" = 'config-service'
             AND proof."dryRun" = false
        ) OR EXISTS (
          SELECT 1
            FROM "config"."tenant_erasure_target_proofs" AS proof
            JOIN "config"."configuration_history" AS history
              ON history."tenant_id" = proof."tenantId"
           WHERE proof."targetService" = 'config-service'
             AND proof."dryRun" = false
        ) THEN
          RAISE EXCEPTION
            'config erasure residual repair postcondition failed';
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        RAISE EXCEPTION
          'cannot roll back historical config erasure residual repair; erased data is intentionally unrecoverable';
      END
      $$
    `);
  }
}
