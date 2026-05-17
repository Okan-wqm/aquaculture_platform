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
 * Ownership boundary:
 *   - domain surface: config.configurations, config.configuration_history,
 *     and their enum/owned-sequence dependencies;
 *   - migration metadata: config.typeorm_migrations and migrations_id_seq.
 *
 * Only the domain surface is transferred to config_service. The migration
 * ledger stays owned by the migrator/admin role because it is infrastructure,
 * not application data. Sequence ownership is therefore discovered through
 * pg_depend against the whitelisted domain tables instead of sweeping every
 * sequence in the config schema.
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
          SELECT DISTINCT seq_cls.relname
            FROM pg_class seq_cls
            JOIN pg_namespace seq_ns ON seq_ns.oid = seq_cls.relnamespace
            JOIN pg_depend dep
              ON dep.objid = seq_cls.oid
             AND dep.classid = 'pg_class'::regclass
             AND dep.refclassid = 'pg_class'::regclass
             AND dep.deptype IN ('a', 'i')
            JOIN pg_class owning_rel ON owning_rel.oid = dep.refobjid
            JOIN pg_namespace owning_ns ON owning_ns.oid = owning_rel.relnamespace
           WHERE seq_ns.nspname = 'config'
             AND seq_cls.relkind = 'S'
             AND owning_ns.nspname = 'config'
             AND owning_rel.relkind IN ('r', 'p')
             AND owning_rel.relname IN ('configurations', 'configuration_history')
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
