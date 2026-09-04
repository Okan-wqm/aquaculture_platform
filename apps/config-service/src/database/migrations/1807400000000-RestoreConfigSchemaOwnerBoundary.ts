import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * RestoreConfigSchemaOwnerBoundary1807400000000
 * ============================================================================
 *
 * `config` was the one schema on the platform whose RUNTIME LOGIN role owned it.
 *
 * Bootstrap stage 008 ("Least-Privilege Runtime Boundary") moves every schema's
 * ownership to a NOLOGIN `<svc>_schema_owner`, reachable only through
 * `GRANT <owner> TO db_migrate`, so a compromised service credential cannot drop
 * or re-shape its own schema. `1800100000000-OwnConfigTablesByConfigService`
 * then ran — service migrations apply after bootstrap — and reversed it with
 * `ALTER SCHEMA config OWNER TO config_service`, asserting that ownership in its
 * own `postCondition()`. Two gates in the same deploy pipeline required opposite
 * states, and the later one won.
 *
 * Nothing noticed because the assertion that checks it
 * (`schema-invariants.spec.ts` B.4) was never executed by any CI step until
 * 2026-07-28, and when it was, it expected the pre-stage-008 model and had to be
 * corrected first. `config` is what the corrected assertion found.
 *
 * ## Why only the SCHEMA moves back
 *
 * 1800100000000's stated reason is real: RLS can only be enabled by the table
 * owner, and config-service installs its tenant RLS policy at boot when
 * `isSchemaDdlOwnedByDbMigrate` is false. That needs ownership of
 * `configurations` and `configuration_history` — it does NOT need ownership of
 * the schema. Schema ownership additionally confers DROP SCHEMA and the right to
 * reassign everything inside it, which is exactly the authority the boundary
 * exists to withhold, and no part of the RLS path uses it.
 *
 * So the tables, types and sequences stay with `config_service` and the boot
 * path is untouched; only the schema returns to the owner role, with
 * `USAGE, CREATE` granted so the service can still create objects it needs.
 *
 * Skips cleanly when `config_schema_owner` does not exist — a database that has
 * not run stage 008 has no boundary to restore, and inventing the role here
 * would put ownership somewhere no grant points at.
 */
export class RestoreConfigSchemaOwnerBoundary1807400000000 implements MigrationInterface {
  name = 'RestoreConfigSchemaOwnerBoundary1807400000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'config');

    const rows: Array<{ applied: boolean }> = await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'config_schema_owner') THEN
          ALTER SCHEMA config OWNER TO config_schema_owner;
          -- The runtime role keeps everything it actually uses: USAGE to reach
          -- the schema, CREATE because the boot-time RLS/audit helpers may add
          -- objects. Neither confers DROP SCHEMA nor REASSIGN OWNED.
          GRANT USAGE, CREATE ON SCHEMA config TO config_service;
        END IF;
      END $$;
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'config_schema_owner') AS applied
    `);

    this.logger.log(
      rows[0]?.applied
        ? 'config schema ownership returned to config_schema_owner; tables stay with config_service for RLS.'
        : 'config_schema_owner absent (pre-stage-008 database) — schema ownership left as found.',
    );
  }

  /**
   * BOTH facts, because each has its own failure mode: the schema must not be
   * owned by the login role (the boundary), and the tables must still be owned
   * by it (the RLS install). A future change that "fixes" one by breaking the
   * other fails here rather than at a service's cold start.
   */
  public async postCondition(qr: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await qr.query(`
      SELECT (
        NOT EXISTS (
          SELECT 1
            FROM pg_namespace n
            JOIN pg_roles r ON r.oid = n.nspowner
           WHERE n.nspname = 'config'
             AND r.rolname = 'config_service'
             AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'config_schema_owner')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_roles r ON r.oid = c.relowner
           WHERE n.nspname = 'config'
             AND c.relkind IN ('r', 'p')
             AND c.relname IN ('configurations', 'configuration_history')
             AND r.rolname <> 'config_service'
        )
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(_qr: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down intentionally a no-op: handing a schema back to a login role would ' +
        're-open the privilege boundary this migration closed.',
    );
  }
}
