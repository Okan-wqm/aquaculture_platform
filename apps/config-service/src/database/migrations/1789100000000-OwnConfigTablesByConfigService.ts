import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * OwnConfigTablesByConfigService1789100000000
 * ============================================================================
 *
 * RLS can only be enabled by the table owner or a privileged migration role.
 * The 178900 table-creation migration may run under the db-migrate/admin role,
 * leaving config.configurations and config.configuration_history owned by that
 * role. At service boot, config_service then fails before it can install RLS.
 *
 * This forward migration transfers the config schema surface to config_service
 * and grants the explicit table/type privileges used by the application role.
 */
export class OwnConfigTablesByConfigService1789100000000 implements MigrationInterface {
  name = 'OwnConfigTablesByConfigService1789100000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'config');

    await qr.query(`
      DO $$
      DECLARE
        seq record;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'config_service'
        ) THEN
          RAISE NOTICE 'config_service role does not exist; skipping config ownership repair';
          RETURN;
        END IF;

        ALTER SCHEMA config OWNER TO config_service;

        ALTER TABLE IF EXISTS config.configurations OWNER TO config_service;
        ALTER TABLE IF EXISTS config.configuration_history OWNER TO config_service;

        ALTER TYPE IF EXISTS config.configurations_value_type_enum OWNER TO config_service;
        ALTER TYPE IF EXISTS config.configurations_environment_enum OWNER TO config_service;

        FOR seq IN
          SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'config'
             AND c.relkind = 'S'
        LOOP
          EXECUTE format('ALTER SEQUENCE config.%I OWNER TO config_service', seq.relname);
        END LOOP;

        GRANT USAGE, CREATE ON SCHEMA config TO config_service;
        GRANT SELECT, INSERT, UPDATE, DELETE
          ON TABLE config.configurations, config.configuration_history
          TO config_service;
        GRANT USAGE
          ON TYPE
            config.configurations_value_type_enum,
            config.configurations_environment_enum
          TO config_service;
        GRANT USAGE, SELECT, UPDATE
          ON ALL SEQUENCES IN SCHEMA config
          TO config_service;
      END $$;
    `);

    this.logger.log('config schema ownership aligned to config_service for RLS bootstrap.');
  }

  public async down(_qr: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down migration intentionally left as no-op: config ownership repair is forward-only.',
    );
  }
}
