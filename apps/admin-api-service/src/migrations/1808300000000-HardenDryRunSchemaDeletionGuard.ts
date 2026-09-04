import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The dry-run deletion guard could not read the table it guards.
 * ============================================================================
 *
 * `admin.reject_dry_run_schema_deletion_job()` (1807500000000) fires BEFORE
 * INSERT OR UPDATE on `platform.tenant_schema_jobs` and refuses a DELETE job
 * whose erasure operation is a dry run. It is SECURITY DEFINER owned by
 * `admin_schema_owner`, and `admin_schema_owner` has no SELECT on
 * `admin.tenant_erasure_operations`: stage 008 of the platform bootstrap owns
 * and grants every relation in a schema, but it runs in Phase 0, BEFORE the
 * service migrations that create this table in Phase 1, so the table it never
 * saw keeps the migration runner as its owner.
 *
 * That alone would have been visible immediately. What hid it for four months
 * is the guard's own shape:
 *
 *     IF NEW.job_type = 'DELETE' AND EXISTS (SELECT … FROM admin.…) THEN
 *
 * PL/pgSQL evaluates that as ONE query. While the cached plan is a custom plan
 * the AND short-circuits and the subquery is never touched, so a
 * PROVISION/RECONCILE job passes. After the fifth execution in a session
 * PL/pgSQL promotes the plan to a generic one, the subquery's relation is
 * permission-checked at executor start whatever `job_type` says, and every
 * later write to the job row fails with
 *
 *     permission denied for table tenant_erasure_operations
 *
 * A short job therefore succeeds and a long one dies partway. Provisioning a
 * real tenant is long: it heartbeats through the replay, crossed the threshold
 * after the farm schema, and left the tenant with farm and none of the other
 * six services (DATA-CRITICAL-010's gate, first live run). Verified against
 * PostgreSQL 16 by reproducing both halves — the same statement passes under a
 * custom plan and raises this error under `plan_cache_mode = force_generic_plan`.
 *
 * Both halves are fixed here, because either alone leaves a real hole:
 *
 *   1. The predicate is split into nested IFs, so the subquery is a separate
 *      SPI plan that is prepared only when the job actually is a DELETE. No
 *      plan shape can make a PROVISION job depend on a privilege it has no
 *      business needing.
 *   2. `admin_schema_owner` is granted SELECT on the table, so the guard works
 *      for the DELETE jobs it exists to judge rather than failing closed on
 *      them with a privilege error that reads like corruption.
 *
 * A new migration rather than an edit: 1807500000000 is recorded applied in
 * every deployed ledger, so editing it would never re-run anywhere.
 */
export class HardenDryRunSchemaDeletionGuard1808300000000 implements MigrationInterface {
  name = 'HardenDryRunSchemaDeletionGuard1808300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The definer needs to read what it guards. USAGE on the schema comes with
    // ownership, but is restated so the grant is complete on its own terms.
    await queryRunner.query(`
      GRANT USAGE ON SCHEMA admin TO admin_schema_owner
    `);
    await queryRunner.query(`
      GRANT SELECT ON TABLE admin.tenant_erasure_operations TO admin_schema_owner
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.reject_dry_run_schema_deletion_job()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        -- Nested, NOT a single AND: the inner query is its own SPI plan and is
        -- prepared only for DELETE jobs, so a generic plan cannot make every
        -- other job type depend on SELECT over admin.tenant_erasure_operations.
        IF NEW.job_type = 'DELETE' THEN
          IF EXISTS (
            SELECT 1
              FROM admin.tenant_erasure_operations AS operation
             WHERE operation.id = NEW.operation_id
               AND operation."dryRun" = true
          ) THEN
            RAISE EXCEPTION
              'tenant schema deletion rejected because erasure operation is a dry run'
              USING ERRCODE = '55000';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      ALTER FUNCTION admin.reject_dry_run_schema_deletion_job()
        OWNER TO admin_schema_owner
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION admin.reject_dry_run_schema_deletion_job()
        FROM PUBLIC
    `);
  }

  /**
   * Probe inside this migration's own transaction, before the ledger row is
   * written: a grant recorded as applied but never made would put the guard
   * straight back into the state that cost a tenant six of its seven schemas.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT
        has_table_privilege(
          'admin_schema_owner', 'admin.tenant_erasure_operations', 'SELECT'
        )
        AND EXISTS (
          SELECT 1
            FROM pg_proc AS proc
            JOIN pg_namespace AS ns ON ns.oid = proc.pronamespace
            JOIN pg_roles AS owner ON owner.oid = proc.proowner
           WHERE ns.nspname = 'admin'
             AND proc.proname = 'reject_dry_run_schema_deletion_job'
             AND proc.prosecdef
             AND owner.rolname = 'admin_schema_owner'
        ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only. Reverting would restore a guard that cannot read its own
    // table; the function's create/drop lifecycle stays with 1807500000000.
  }
}
