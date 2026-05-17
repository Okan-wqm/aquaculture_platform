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
        rel record;
        seq record;
        typ record;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'config_service'
        ) THEN
          RAISE NOTICE 'config_service role does not exist; skipping config ownership repair';
          RETURN;
        END IF;

        ALTER SCHEMA config OWNER TO config_service;

        FOR rel IN
          SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'config'
             AND c.relkind IN ('r', 'p')
             AND c.relname IN ('configurations', 'configuration_history')
        LOOP
          EXECUTE format('ALTER TABLE %I.%I OWNER TO config_service', 'config', rel.relname);
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO config_service',
            'config',
            rel.relname
          );
        END LOOP;

        FOR typ IN
          SELECT t.typname
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'config'
             AND t.typname IN (
               'configurations_value_type_enum',
               'configurations_environment_enum'
             )
        LOOP
          EXECUTE format('ALTER TYPE %I.%I OWNER TO config_service', 'config', typ.typname);
          EXECUTE format('GRANT USAGE ON TYPE %I.%I TO config_service', 'config', typ.typname);
        END LOOP;

        FOR seq IN
          SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'config'
             AND c.relkind = 'S'
        LOOP
          EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO config_service', 'config', seq.relname);
          EXECUTE format(
            'GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I.%I TO config_service',
            'config',
            seq.relname
          );
        END LOOP;

        GRANT USAGE, CREATE ON SCHEMA config TO config_service;
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
