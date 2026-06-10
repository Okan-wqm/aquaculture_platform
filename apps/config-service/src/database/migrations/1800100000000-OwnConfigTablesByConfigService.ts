import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * OwnConfigTablesByConfigService1800100000000
 * ============================================================================
 *
 * RLS can only be enabled by the table owner or a privileged migration role.
 * Day-one baselines create config.configurations and
 * config.configuration_history from the db-migrate container, which can leave
 * both domain tables owned by the migrator/admin role. config-service then
 * reaches boot and fails while installing tenant RLS.
 *
 * This migration is deliberately forward-only and idempotent:
 *   - domain tables, enum types, and owned sequences move to config_service;
 *   - the migration ledger stays owned by the migrator role;
 *   - both configurations and configuration_history remain RLS-managed.
 */
export class OwnConfigTablesByConfigService1800100000000 implements MigrationInterface {
  name = 'OwnConfigTablesByConfigService1800100000000';

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
          RAISE EXCEPTION 'config_service role does not exist; refusing to skip config ownership repair';
        END IF;

        ALTER SCHEMA config OWNER TO config_service;
        GRANT USAGE, CREATE ON SCHEMA config TO config_service;

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
      END $$;
    `);

    this.logger.log('config schema ownership aligned to config_service for RLS bootstrap.');
  }

  public async postCondition(qr: QueryRunner): Promise<boolean> {
    const rows: Array<{ missing: string }> = await qr.query(`
      WITH expected AS (
        SELECT 'schema:config' AS label
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_namespace n
            JOIN pg_roles r ON r.oid = n.nspowner
           WHERE n.nspname = 'config'
             AND r.rolname = 'config_service'
        )
        UNION ALL
        SELECT 'table:' || c.relname AS label
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_roles r ON r.oid = c.relowner
         WHERE n.nspname = 'config'
           AND c.relkind IN ('r', 'p')
           AND c.relname IN ('configurations', 'configuration_history')
           AND r.rolname <> 'config_service'
        UNION ALL
        SELECT 'type:' || t.typname AS label
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_roles r ON r.oid = t.typowner
         WHERE n.nspname = 'config'
           AND t.typname IN (
             'configurations_value_type_enum',
             'configurations_environment_enum'
           )
           AND r.rolname <> 'config_service'
        UNION ALL
        SELECT 'sequence:' || seq_cls.relname AS label
          FROM pg_class seq_cls
          JOIN pg_namespace seq_ns ON seq_ns.oid = seq_cls.relnamespace
          JOIN pg_roles seq_owner ON seq_owner.oid = seq_cls.relowner
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
           AND owning_rel.relname IN ('configurations', 'configuration_history')
           AND seq_owner.rolname <> 'config_service'
      )
      SELECT label AS missing FROM expected
    `);
    if (rows.length > 0) {
      this.logger.error(
        `config ownership post-condition failed: ${rows.map((r) => r.missing).join(', ')}`,
      );
      return false;
    }
    return true;
  }

  public async down(_qr: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down migration intentionally left as no-op: config ownership repair is forward-only.',
    );
  }
}
