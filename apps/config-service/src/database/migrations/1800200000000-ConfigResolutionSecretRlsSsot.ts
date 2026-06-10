import { MigrationInterface, QueryRunner } from 'typeorm';

const GLOBAL_TENANT_UUID = '00000000-0000-0000-0000-000000000000';

export class ConfigResolutionSecretRlsSsot1800200000000
  implements MigrationInterface
{
  name = 'ConfigResolutionSecretRlsSsot1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "config"."configurations"
      SET "value_type" = 'secret'
      WHERE "is_secret" = true OR "value_type" = 'secret'
    `);
    await queryRunner.query(`
      UPDATE "config"."configurations"
      SET "is_secret" = ("value_type" = 'secret')
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
      DROP CONSTRAINT IF EXISTS "CHK_configurations_secret_classification_ssot"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "config"."configurations"
        ADD CONSTRAINT "CHK_configurations_secret_classification_ssot"
        CHECK (
          ("value_type" = 'secret' AND "is_secret" = true)
          OR
          ("value_type" <> 'secret' AND "is_secret" = false)
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'config'
            AND table_name = 'configurations'
            AND column_name = 'created_at'
            AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE "config"."configurations"
          ALTER COLUMN "created_at" TYPE TIMESTAMP WITH TIME ZONE
          USING "created_at" AT TIME ZONE 'UTC';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'config'
            AND table_name = 'configurations'
            AND column_name = 'updated_at'
            AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE "config"."configurations"
          ALTER COLUMN "updated_at" TYPE TIMESTAMP WITH TIME ZONE
          USING "updated_at" AT TIME ZONE 'UTC';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'config'
            AND table_name = 'configuration_history'
            AND column_name = 'changed_at'
            AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE "config"."configuration_history"
          ALTER COLUMN "changed_at" TYPE TIMESTAMP WITH TIME ZONE
          USING "changed_at" AT TIME ZONE 'UTC';
        END IF;
      END $$;
    `);

    await this.installConfigPolicies(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP POLICY IF EXISTS "configurations_select_tenant_or_global"
      ON "config"."configurations"
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "configurations_insert_current_tenant"
      ON "config"."configurations"
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "configurations_update_current_tenant"
      ON "config"."configurations"
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "configurations_delete_current_tenant"
      ON "config"."configurations"
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS "configuration_history_current_tenant"
      ON "config"."configuration_history"
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configurations"
      DROP CONSTRAINT IF EXISTS "CHK_configurations_secret_classification_ssot"
    `);
  }

  private async installConfigPolicies(queryRunner: QueryRunner): Promise<void> {
    const currentTenant =
      `NULLIF(current_setting('app.current_tenant', true), '')::uuid`;
    const bypass = `current_setting('app.bypass_rls', true) = 'on'`;
    const ownTenant = `"tenant_id" = ${currentTenant}`;
    const globalTenant = `"tenant_id" = '${GLOBAL_TENANT_UUID}'::uuid`;
    const ownOrBypass = `(${bypass} OR ${ownTenant})`;
    const selectConfig = `(${bypass} OR ${ownTenant} OR ${globalTenant})`;

    await queryRunner.query(`
      ALTER TABLE "config"."configurations" ENABLE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configurations" FORCE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configuration_history" ENABLE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE "config"."configuration_history" FORCE ROW LEVEL SECURITY
    `);

    for (const table of ['configurations', 'configuration_history']) {
      await queryRunner.query(`
        DROP POLICY IF EXISTS "tenant_isolation_policy"
        ON "config"."${table}"
      `);
    }

    await queryRunner.query(`
      CREATE POLICY "configurations_select_tenant_or_global"
      ON "config"."configurations"
      FOR SELECT
      USING ${selectConfig}
    `);
    await queryRunner.query(`
      CREATE POLICY "configurations_insert_current_tenant"
      ON "config"."configurations"
      FOR INSERT
      WITH CHECK ${ownOrBypass}
    `);
    await queryRunner.query(`
      CREATE POLICY "configurations_update_current_tenant"
      ON "config"."configurations"
      FOR UPDATE
      USING ${ownOrBypass}
      WITH CHECK ${ownOrBypass}
    `);
    await queryRunner.query(`
      CREATE POLICY "configurations_delete_current_tenant"
      ON "config"."configurations"
      FOR DELETE
      USING ${ownOrBypass}
    `);
    await queryRunner.query(`
      CREATE POLICY "configuration_history_current_tenant"
      ON "config"."configuration_history"
      FOR ALL
      USING ${ownOrBypass}
      WITH CHECK ${ownOrBypass}
    `);
  }
}
