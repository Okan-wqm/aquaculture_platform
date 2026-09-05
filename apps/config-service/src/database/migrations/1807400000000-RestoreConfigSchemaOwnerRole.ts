import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Return ownership of the `config` SCHEMA to its NOLOGIN owner role.
 * ============================================================================
 *
 * `008-least-privilege-hardening.sql` separates schema ownership from the
 * runtime login: a NOLOGIN `<svc>_schema_owner` owns the schema, and
 * `<svc>_service` logs in with DML. Ownership carries DROP and ALTER over every
 * object in the schema, which is exactly what a login role must not hold.
 *
 * `1800100000000-OwnConfigTablesByConfigService` runs in Phase 1, after that
 * hardening, and opens with
 *
 *     ALTER SCHEMA config OWNER TO config_service;
 *
 * so the `config` schema ends every deploy owned by its login role. The
 * migration's own docblock does not claim that: it justifies moving "domain
 * tables, enum types, and owned sequences" so config-service can enable tenant
 * RLS at boot, which needs TABLE ownership. Schema ownership is collateral —
 * beyond the migration's stated contract and against the platform's.
 *
 * This returns the schema to `config_schema_owner` and leaves everything the
 * RLS rationale actually depends on untouched: the tables, types and sequences
 * stay with `config_service`, and the `USAGE, CREATE` grant stays too. A grant
 * of CREATE lets the service add objects; it does not confer DROP over the ones
 * already there. That is the whole difference this migration restores.
 *
 * A new migration rather than an edit: 1800100000000 is recorded applied in
 * every deployed ledger, so editing it would never re-run.
 *
 * Found by `schema-invariants` B.4 the first time it ran with `config` in its
 * expectation set — the stale hardcoded list it replaced had fourteen schemas
 * and omitted this one, so nothing had ever asserted config's ownership.
 */
export class RestoreConfigSchemaOwnerRole1807400000000 implements MigrationInterface {
  name = 'RestoreConfigSchemaOwnerRole1807400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Unconditional on purpose: `config_schema_owner` is created by bootstrap
    // stage 008, which runs in Phase 0 before any migration. If it is missing,
    // the bootstrap did not run and this deploy should stop rather than leave
    // the schema owned by a login role.
    await queryRunner.query(`ALTER SCHEMA config OWNER TO config_schema_owner`);

    // Restated so the grant this migration relies on is visible where the
    // ownership decision is made, rather than only in the migration that took
    // ownership away.
    await queryRunner.query(`GRANT USAGE, CREATE ON SCHEMA config TO config_service`);
  }

  /**
   * Probe inside this migration's own transaction, before the ledger row is
   * written: an ownership change recorded as applied but never made would put
   * DROP over every config object back in a login role's hands, silently.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_namespace AS ns
          JOIN pg_catalog.pg_roles AS owner ON owner.oid = ns.nspowner
         WHERE ns.nspname = 'config'
           AND owner.rolname = 'config_schema_owner'
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only. Reverting would hand schema ownership — DROP and ALTER over
    // every config object — back to the runtime login role.
  }
}
