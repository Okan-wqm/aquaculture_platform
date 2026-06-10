import { MigrationLogger } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RestoreCaseInsensitiveEmailUniqueness1800100000000
 * ============================================================================
 *
 * WHY THIS MIGRATION EXISTS (audit finding, 2026-06-10 auth-service audit):
 * the 1800000000000-Baseline consolidation dropped BOTH email uniqueness
 * indexes on `auth.users` — neither the legacy `UNIQUE (email)` nor the
 * case-insensitive `UNIQUE (LOWER(email))` (originally installed by the
 * archived EnforceCaseInsensitiveEmailUniqueness1781300000000) survived the
 * squash. Fresh databases bootstrapped from Baseline therefore had NO
 * database-level email uniqueness at all: any code path that forgets to
 * normalise (future bugs, admin scripts running raw SQL) could insert
 * duplicate accounts authenticating against the same address.
 *
 * This migration re-installs the case-insensitive expression index. On
 * environments that migrated through the original pre-Baseline timeline the
 * index already exists and `IF NOT EXISTS` makes this a no-op.
 *
 * # Pre-check: fail loud on existing duplicates
 *
 * A `CREATE UNIQUE INDEX` against a table with duplicate values under the
 * new predicate fails with an unhelpful `duplicate key` error and leaves the
 * deploy in a partial state. The migration therefore runs a
 * duplicate-detection query FIRST. If duplicates exist it raises a hard
 * error listing the offending addresses and aborts BEFORE any DDL. Operators
 * then merge the duplicate accounts manually (row selection requires domain
 * knowledge — not performed by this DDL migration) and re-run.
 *
 * # TypeORM decorator vs expression index
 *
 * TypeORM's `@Index` decorator accepts column names but not SQL expressions —
 * `UNIQUE (LOWER(col))` cannot be declared through decorators. user.entity.ts
 * intentionally carries no email unique decorator and points at this class
 * by name.
 *
 * # Idempotency
 *
 * The pre-check runs unconditionally and is read-only; `DROP INDEX IF
 * EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS` make the index installation
 * a no-op where it was already applied. Safe to re-run.
 */
export class RestoreCaseInsensitiveEmailUniqueness1800100000000
  implements MigrationInterface
{
  name = 'RestoreCaseInsensitiveEmailUniqueness1800100000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Restoring case-insensitive UNIQUE(LOWER(email)) on auth.users (lost in Baseline consolidation)',
    );

    // ── Pre-check: fail loud if case-insensitive duplicates exist ─────
    // GROUP BY LOWER(email) HAVING count > 1 surfaces every pair where
    // two or more rows share the same lowercased address. If this is
    // non-empty, we abort the migration with an actionable error so
    // operators can resolve the duplicates before retry.
    const duplicateRows = (await queryRunner.query(`
        SELECT LOWER("email") AS lowered, COUNT(*)::text AS count
        FROM "auth"."users"
        GROUP BY LOWER("email")
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, LOWER("email")
      `)) as Array<{ lowered: string; count: string }>;

    if (duplicateRows.length > 0) {
      // Build a clear, grep-friendly error message that operators can
      // paste directly into a runbook. Output capped at 10 entries so a
      // mass-duplicate scenario doesn't spam the deploy logs.
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

    // ── Drop any stray legacy case-sensitive unique index ────────────
    // Baseline-fresh databases never had it; environments that migrated
    // through the original timeline had it dropped by the archived
    // migration. IF EXISTS covers any environment caught between states.
    await queryRunner.query(`DROP INDEX IF EXISTS "auth"."IDX_users_email"`);

    // ── Create the case-insensitive unique expression index ──────────
    // `LOWER("email")` is an expression index — the planner can use it
    // for both the unique constraint AND for queries of the form
    // `WHERE LOWER(email) = $1`. Column name is quoted because the
    // underlying column uses camelCase.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"
      ON "auth"."users" (LOWER("email"))
    `);
    this.logger.log('Created users_email_lower_key (UNIQUE LOWER(email))');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback returns to the (defective) Baseline state: no email
    // uniqueness at the database level. We deliberately do NOT recreate
    // the legacy case-sensitive index — Baseline never had it, and
    // installing a constraint on rollback could itself fail on data.
    this.logger.warn(
      'Dropping users_email_lower_key — this reopens the case-variant duplicate account hole.',
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "auth"."users_email_lower_key"`);
  }
}
