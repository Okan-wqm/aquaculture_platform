import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAuthUsersTenantFk1787200000000
 * ============================================================================
 *
 * Adds the missing FOREIGN KEY constraint on `auth.users.tenantId`
 * referencing `auth.tenants(id)`. Pre-fix the column was a bare `uuid`
 * with no referential integrity — a tenant could be deleted without
 * cascading impact on its users, leaving orphan auth.users rows whose
 * tenantId pointed at a non-existent tenant.
 *
 * # Why this matters
 *
 * AUDIT FINDING: DBR-HIGH-002 captured the gap. Symptoms:
 *
 *   1. Tenant offboarding leaves orphan users — a future tenant with
 *      the recycled UUID would unexpectedly inherit them.
 *   2. PURGE saga can ALTER tenant rows without DB-level guard against
 *      breaking user-↔-tenant invariants.
 *   3. The MT-CRITICAL-001 cure (W0.F) tightened the application-layer
 *      tenant trust anchor; the DB-level integrity gap remained the
 *      last loophole — a stale orphan row could still claim tenancy
 *      via JWT regenerated for a deleted tenant.
 *
 * # Why ON DELETE RESTRICT (not CASCADE)
 *
 * Cascading user deletion when a tenant is deleted feels convenient
 * but is the WRONG SHAPE for compliance. GDPR Art 17 erasure has its
 * own structured cascade (W2.5 follow-up) that emits TenantErased and
 * lets each tenant-data-bearing service erase itself in audited order.
 * A blind ON DELETE CASCADE would rip user rows out of band, skipping
 * audit + legal-hold checks. RESTRICT enforces "cannot delete a tenant
 * that still has users" — the right shape, with the GDPR cascade as
 * the explicit deletion path.
 *
 * # Pre-flight: orphan handling
 *
 * The migration first detects orphan rows (auth.users.tenantId
 * referencing a non-existent auth.tenants.id) and FAILS LOUD if any
 * exist. Operators run the runbook to either recreate the missing
 * tenant or NULL the orphan tenantId before re-applying. SUPER_ADMIN
 * users with NULL tenantId are exempt from the FK by design (the
 * column is nullable; the FK only fires on non-null values).
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-HIGH-002
 */
export class AddAuthUsersTenantFk1787200000000 implements MigrationInterface {
  name = 'AddAuthUsersTenantFk1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-flight: detect orphan rows before adding the constraint. The
    // alternative — silently NULLing orphans here — would mask data
    // corruption that the operator must triage. Fail-loud is the right
    // default for compliance-critical schema changes.
    const orphans: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM auth.users u
      LEFT JOIN auth.tenants t ON t.id = u."tenantId"
      WHERE u."tenantId" IS NOT NULL AND t.id IS NULL
    `);
    const orphanCount = Number(orphans[0]?.count ?? '0');
    if (orphanCount > 0) {
      throw new Error(
        `Refusing to add auth.users.tenantId FK: ${orphanCount} orphan user row(s) point at non-existent tenants. ` +
          'Run docs/runbooks/auth-users-tenant-fk-orphan-triage.md to either restore the missing tenant rows ' +
          'or NULL the orphan tenantId column on the affected users (effectively demoting them to SUPER_ADMIN-eligible / no-tenant state) ' +
          'before re-applying this migration.',
      );
    }

    // Idempotent: if the constraint already exists (e.g., earlier
    // partial run), do nothing. Postgres errors on duplicate constraint
    // names so the IF EXISTS guard pre-checks the catalog.
    const existing: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = 'auth'
          AND r.relname = 'users'
          AND c.conname = 'FK_auth_users_tenantId'
      ) AS exists
    `);
    if (existing[0]?.exists) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE auth.users
      ADD CONSTRAINT "FK_auth_users_tenantId"
      FOREIGN KEY ("tenantId")
      REFERENCES auth.tenants("id")
      ON DELETE RESTRICT
      ON UPDATE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down is permitted here — removing this FK does not destroy data,
    // only weakens referential integrity. Operators may need to drop
    // the FK temporarily to perform a tenant-rename that does NOT use
    // ON UPDATE CASCADE for some reason.
    await queryRunner.query(`
      ALTER TABLE auth.users
      DROP CONSTRAINT IF EXISTS "FK_auth_users_tenantId"
    `);
  }
}
