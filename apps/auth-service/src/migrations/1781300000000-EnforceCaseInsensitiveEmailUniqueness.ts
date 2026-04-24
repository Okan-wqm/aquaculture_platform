import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * EnforceCaseInsensitiveEmailUniqueness1781300000000
 * ============================================================================
 *
 * Replaces the case-sensitive `IDX_users_email` unique index with a
 * case-insensitive expression index on `LOWER(email)`.
 *
 * # Why
 *
 * The prior `IDX_users_email` was a plain `UNIQUE (email)` index — meaning
 * `User@X.com` and `user@x.com` were considered different. Application
 * code already normalises email to lowercase on every write path (see
 * authentication.service, webauthn.service, tenant-admin.service), BUT:
 *
 * 1. Any code path that forgets to normalise (including future bugs and
 *    admin scripts that run raw SQL) can insert a duplicate account,
 *    producing two separate users that authenticate against the same
 *    underlying address.
 * 2. A migration or seed script running `INSERT ... ON CONFLICT` cannot
 *    rely on the old index because `('User@X.com')` does not conflict
 *    with `('user@x.com')`.
 *
 * Moving uniqueness to `UNIQUE (LOWER(email))` closes both holes:
 *
 * - Case-insensitive uniqueness is enforced **at the database**, not the
 *   application, so forgotten normalisation no longer creates duplicates.
 * - Query planner can use the expression index for case-insensitive
 *   lookups (`WHERE LOWER(email) = LOWER($1)`) if we ever need them,
 *   without forcing a full-table scan.
 *
 * # Pre-check: fail loud on existing duplicates
 *
 * A `CREATE UNIQUE INDEX` against a table with duplicate values under
 * the new predicate fails with `duplicate key value violates unique
 * constraint`. Running that blind in production gives an unhelpful
 * error message and leaves the schema in a partial state.
 *
 * The migration therefore runs a duplicate-detection query BEFORE
 * dropping the old index. If duplicates exist, the migration raises a
 * hard error listing the offending email addresses, and the deploy
 * aborts before any schema change happens. Operators then:
 *
 *   1. Investigate each duplicate pair manually
 *   2. Merge the two accounts (data migration — not performed by this
 *      DDL migration because row-selection requires domain knowledge
 *      about which row to keep and which to retire)
 *   3. Re-run the migration
 *
 * This is the only safe pattern for introducing a tighter constraint
 * onto an existing table.
 *
 * # TypeORM decorator vs expression index
 *
 * TypeORM's `@Index` decorator accepts column names but not SQL
 * expressions — there is no way to declare `UNIQUE (LOWER(col))`
 * through decorators. The user.entity.ts decorator was updated to
 * drop the old `@Index('IDX_users_email', ...)` line and the column-
 * level `unique: true`, delegating uniqueness enforcement to this
 * migration. A companion code comment in user.entity.ts points at
 * this class by name so future readers know where to look.
 *
 * # Idempotency
 *
 * - The duplicate pre-check runs unconditionally; if the new index
 *   already exists, the check still runs harmlessly before the DROP/
 *   CREATE no-ops.
 * - `DROP INDEX IF EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS`
 *   make the index swap a no-op on environments where it was already
 *   applied. Safe to re-run.
 */
export class EnforceCaseInsensitiveEmailUniqueness1781300000000
  implements MigrationInterface
{
  name = 'EnforceCaseInsensitiveEmailUniqueness1781300000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Converting users.email uniqueness from case-sensitive (email) to case-insensitive (LOWER(email))',
    );

    // ── Pre-check: fail loud if case-insensitive duplicates exist ─────
    // GROUP BY LOWER(email) HAVING count > 1 surfaces every pair where
    // two or more rows share the same lowercased address. If this is
    // non-empty, we abort the migration with an actionable error so
    // operators can resolve the duplicates before retry.
    const duplicateRows: Array<{ lowered: string; count: string }> =
      await queryRunner.query(`
        SELECT LOWER("email") AS lowered, COUNT(*)::text AS count
        FROM "users"
        GROUP BY LOWER("email")
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, LOWER("email")
      `);

    if (duplicateRows.length > 0) {
      // Build a clear, grep-friendly error message that operators can
      // paste directly into a runbook. We cap the output at 10 entries
      // so a mass-duplicate scenario doesn't spam the deploy logs with
      // thousands of lines.
      const shown = duplicateRows.slice(0, 10);
      const rest = duplicateRows.length - shown.length;
      const list = shown
        .map((r) => `  - ${r.lowered} (${r.count} rows)`)
        .join('\n');
      const suffix = rest > 0 ? `\n  ... and ${rest} more` : '';

      throw new Error(
        `Refusing to install case-insensitive unique index: ` +
          `${duplicateRows.length} email address(es) have case-insensitive duplicates.\n` +
          `Resolve these duplicates manually before re-running the migration.\n` +
          `Affected addresses:\n${list}${suffix}`,
      );
    }

    // ── Drop the old case-sensitive unique index ─────────────────────
    // TypeORM created `IDX_users_email` as a plain UNIQUE (email)
    // B-tree. Dropping it now is safe because the new index we
    // create below covers the same usage (both are unique indexes
    // that accelerate email lookups).
    //
    // IF EXISTS makes this idempotent on environments where the old
    // index was already removed.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_email"`);
    this.logger.log('Dropped legacy IDX_users_email (case-sensitive)');

    // ── Create the new case-insensitive unique expression index ──────
    // `LOWER("email")` is an expression index — the planner can use it
    // for both the unique constraint AND for queries of the form
    // `WHERE LOWER(email) = $1`. Column name is quoted because the
    // underlying column uses camelCase.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"
      ON "users" (LOWER("email"))
    `);
    this.logger.log('Created users_email_lower_key (UNIQUE LOWER(email))');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback re-creates the legacy index AND performs the same
    // duplicate pre-check. Running down() on an environment that
    // accumulated case-variant duplicates while up() was in place
    // would otherwise fail late with a generic unique violation.
    this.logger.warn(
      'Rolling back to case-sensitive users.email uniqueness — ' +
        'this reopens the case-variant duplicate account hole.',
    );

    const duplicateRows: Array<{ email: string; count: string }> =
      await queryRunner.query(`
        SELECT "email", COUNT(*)::text AS count
        FROM "users"
        GROUP BY "email"
        HAVING COUNT(*) > 1
      `);

    if (duplicateRows.length > 0) {
      throw new Error(
        `Refusing to install case-sensitive unique index on rollback: ` +
          `${duplicateRows.length} email(s) already have exact duplicates. ` +
          `Investigate data anomalies before retrying down().`,
      );
    }

    await queryRunner.query(
      `DROP INDEX IF EXISTS "users_email_lower_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`,
    );
    this.logger.warn('Rolled back to legacy IDX_users_email');
  }
}
