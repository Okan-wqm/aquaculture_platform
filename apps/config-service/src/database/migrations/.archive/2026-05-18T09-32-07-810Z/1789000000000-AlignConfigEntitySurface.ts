import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AlignConfigEntitySurface1789000000000
 * ============================================================================
 *
 * Creates the two `config` schema tables that the 2026-05-08
 * bootstrap-from-scratch test reported as completely missing:
 *
 *   - config.configurations         (Configuration entity)
 *   - config.configuration_history  (ConfigurationHistory entity)
 *
 * Both are declared with explicit `{ schema: 'config' }` decorators in
 * `apps/config-service/src/configuration/entities/configuration.entity.ts`.
 * Pre-fix the only path that materialised them was the deprecated
 * `synchronize: true` boot mode.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignConfigEntitySurface1789000000000
  implements MigrationInterface
{
  name = 'AlignConfigEntitySurface1789000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'config');
    await qr.query(`CREATE SCHEMA IF NOT EXISTS config`);

    // 1. configurations_value_type_enum.
    await qr.query(`
      DO $$
      BEGIN
        CREATE TYPE config.configurations_value_type_enum AS ENUM (
          'string', 'number', 'boolean', 'json', 'secret'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // 2. configurations_environment_enum.
    await qr.query(`
      DO $$
      BEGIN
        CREATE TYPE config.configurations_environment_enum AS ENUM (
          'development', 'staging', 'production', 'all'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // 3. config.configurations.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS config.configurations (
        "id"               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        "tenant_id"        uuid NOT NULL,
        "service"          varchar(100) NOT NULL,
        "key"              varchar(255) NOT NULL,
        "value"            text NOT NULL,
        "value_type"       config.configurations_value_type_enum NOT NULL DEFAULT 'string',
        "environment"      config.configurations_environment_enum NOT NULL DEFAULT 'all',
        "description"      varchar(500),
        "is_secret"        boolean NOT NULL DEFAULT false,
        "is_active"        boolean NOT NULL DEFAULT true,
        "default_value"    varchar(255),
        "validation_rules" jsonb,
        "category"         varchar(50),
        "tags"             text[],
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        "created_by"       varchar(100),
        "updated_by"       varchar(100),
        "version"          int NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_configurations_tenant_service_key_environment"
          UNIQUE ("tenant_id", "service", "key", "environment")
      );
      CREATE INDEX IF NOT EXISTS "IDX_configurations_tenant_id"
        ON config.configurations ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_configurations_service_field"
        ON config.configurations ("service");
      CREATE INDEX IF NOT EXISTS "IDX_configurations_isActive"
        ON config.configurations ("is_active");
      CREATE INDEX IF NOT EXISTS "IDX_configurations_tenant_service"
        ON config.configurations ("tenant_id", "service");
      CREATE INDEX IF NOT EXISTS "IDX_configurations_service_key"
        ON config.configurations ("service", "key");
    `);

    // 4. config.configuration_history.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS config.configuration_history (
        "id"               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        "configuration_id" uuid NOT NULL,
        "tenant_id"        uuid NOT NULL,
        "service"          varchar(100) NOT NULL,
        "key"              varchar(255) NOT NULL,
        "previous_value"   text NOT NULL,
        "new_value"        text NOT NULL,
        "changed_by"       varchar(100) NOT NULL,
        "changed_at"       timestamptz NOT NULL,
        "change_reason"    varchar(255)
      );
      CREATE INDEX IF NOT EXISTS "IDX_configuration_history_configurationId"
        ON config.configuration_history ("configuration_id");
      CREATE INDEX IF NOT EXISTS "IDX_configuration_history_config_changedAt"
        ON config.configuration_history ("configuration_id", "changed_at");
      CREATE INDEX IF NOT EXISTS "IDX_configuration_history_tenant_changedAt"
        ON config.configuration_history ("tenant_id", "changed_at");
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'config');
    await qr.query(`DROP TABLE IF EXISTS config.configuration_history`);
    await qr.query(`DROP TABLE IF EXISTS config.configurations`);
    await qr.query(`DROP TYPE IF EXISTS config.configurations_environment_enum`);
    await qr.query(`DROP TYPE IF EXISTS config.configurations_value_type_enum`);
  }
}
