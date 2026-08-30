import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RestoreAuthUsersTenantFk1808300000000
 * ============================================================================
 *
 * Restores the `FK_auth_users_tenantId` FOREIGN KEY that the 2026-05-18
 * migration squash dropped.
 *
 * # What happened
 *
 * `AddAuthUsersTenantFk1787200000000` closed DBR-HIGH-002: `auth.users.tenantId`
 * was a bare `uuid` with no referential integrity, so deleting a tenant left
 * orphan user rows whose tenantId pointed at nothing — and a future tenant
 * issued the recycled UUID would inherit them. The squash into
 * `Baseline1800000000000` did not carry the constraint forward, and the archived
 * file under `src/migrations/.archive/` is never applied: every service
 * registers `migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}']`, which
 * neither matches a dot-directory nor descends into one.
 *
 * # Why nobody noticed
 *
 * `tests/invariants/auth-users-tenant-fk.spec.ts` guards exactly this
 * constraint and was GREEN. It collected migrations with
 * `git ls-files 'apps/auth-service/src/migrations/*.ts'`, and a git pathspec
 * `*` crosses `/` — so it read all 32 files including the 13 archived ones and
 * found the constraint in a migration the runtime never runs. A gate reporting
 * green off dead evidence is worse than no gate: it is a standing claim that
 * something is protected when it is not. That is ORPHAN-CRITICAL-516; the
 * invariants now read the effective set through
 * `tests/invariants/lib/migration-corpus.ts`.
 *
 * # Why ON DELETE RESTRICT (not CASCADE)
 *
 * Unchanged from the original and still the right shape. Cascading user
 * deletion would rip rows out of band, skipping the audit + legal-hold checks
 * that GDPR Art 17 erasure performs — that cascade emits TenantErased and lets
 * each tenant-data-bearing service erase itself in audited order. RESTRICT
 * enforces "a tenant with users cannot be deleted", leaving the audited path as
 * the only deletion route.
 *
 * # Forward-only, and idempotent
 *
 * A new migration rather than an edit to the baseline, per the repository's
 * never-hand-edit rule. The catalog pre-check makes re-application a no-op, so
 * an environment that somehow still carries the constraint is unaffected.
 *
 * Closes: docs/reviews/2026-07-26-aria-codex-audit-verification.md#ORPHAN-CRITICAL-516
 */
export class RestoreAuthUsersTenantFk1808300000000 implements MigrationInterface {
  name = 'RestoreAuthUsersTenantFk1808300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-flight: detect orphan rows before adding the constraint. Silently
    // NULLing them here would mask data corruption an operator must triage, and
    // the FK cannot be added over rows that already violate it. Fail-loud is the
    // right default for a compliance-critical schema change.
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

    // Idempotent INSIDE the statement, not via a preceding probe. Postgres has
    // no `IF NOT EXISTS` for ADD CONSTRAINT, and the earlier draft of this
    // migration ran a `pg_constraint` catalog check and returned early — which
    // the migration SQL linter rejected, correctly. Two statements leave a
    // window between the check and the add, and a replay that lands in that
    // window fails with 42710. The exception handler closes it.
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE auth.users
        ADD CONSTRAINT "FK_auth_users_tenantId"
        FOREIGN KEY ("tenantId")
        REFERENCES auth.tenants("id")
        ON DELETE RESTRICT
        ON UPDATE CASCADE;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down is permitted: dropping this FK weakens referential integrity but
    // destroys no data, and an operator may need it dropped to perform a
    // tenant-key rewrite that ON UPDATE CASCADE cannot express.
    await queryRunner.query(`
      ALTER TABLE auth.users
      DROP CONSTRAINT IF EXISTS "FK_auth_users_tenantId"
    `);
  }
}
