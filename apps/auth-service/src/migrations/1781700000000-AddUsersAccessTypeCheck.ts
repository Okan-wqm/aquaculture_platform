import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * AddUsersAccessTypeCheck1781700000000
 * ============================================================================
 *
 * Installs a CHECK constraint enforcing that `users.accessType` holds one
 * of the three legal values — `'PANEL_ONLY'`, `'MOBILE_ONLY'`, `'BOTH'`
 * — or NULL (for legacy rows provisioned before the column was added).
 *
 * # Why
 *
 * `users.accessType` is defined in user.entity.ts as:
 *
 *     @Column({
 *       type: 'varchar',
 *       length: 20,
 *       nullable: true,
 *       default: 'BOTH',
 *     })
 *     accessType?: AccessType | null;
 *
 * and the `AccessType` TypeScript enum restricts it to:
 *
 *     enum AccessType { PANEL_ONLY, MOBILE_ONLY, BOTH }
 *
 * The TypeScript layer enforces this on every write that goes through
 * the application, but that's:
 *
 *   1. **Bypassable**: raw SQL, admin tooling, database-level migrations
 *      and bulk imports can all write arbitrary varchar values into the
 *      column. The AccessType column is consumed at login time to
 *      decide whether to route a user to the web panel or the mobile
 *      PWA (see `accessType?: AccessType | null` in user.entity and
 *      the matching logic in `AuthenticationService.generateTokens`).
 *      A row with `accessType = 'hacker'` silently breaks routing logic
 *      for that user — the TypeORM entity coerces the unknown value to
 *      the `AccessType` type at read time without validation.
 *
 *   2. **Silent**: an invalid value does not raise an error; it just
 *      produces unexpected behaviour at runtime, which is the worst
 *      failure mode. A CHECK constraint moves this from a hard-to-
 *      diagnose runtime bug to an INSERT-time error that the offending
 *      code path must handle.
 *
 * # Why not `CREATE TYPE ... AS ENUM` instead?
 *
 * Two reasons:
 *
 *   1. **Migration cost.** Converting an existing varchar column to a
 *      native PG enum requires an ALTER COLUMN TYPE with a USING cast.
 *      CHECK achieves the same integrity guarantee without a table
 *      rewrite.
 *
 *   2. **Evolution cost.** Adding a new enum value in PG requires an
 *      `ALTER TYPE ... ADD VALUE`, which only works in the top-level
 *      transaction (not inside a larger migration) on older PG
 *      versions. A CHECK on a varchar can be widened or tightened via
 *      regular `DROP CONSTRAINT / ADD CONSTRAINT` without any of those
 *      constraints.
 *
 * The `database-design:postgresql` skill explicitly calls this out:
 *
 *     ENUMs: `CREATE TYPE ... AS ENUM` for small, stable sets
 *            (e.g. US states, days of week). For business-logic-driven
 *            and evolving values (e.g. order statuses) → use TEXT
 *            (or INT) + CHECK or lookup table.
 *
 * `accessType` is business-logic-driven — a future deploy might add
 * `READ_ONLY` or `ADMIN_CONSOLE` or similar — so CHECK is the correct
 * choice.
 *
 * # Handling pre-existing bad data
 *
 * If any row has an `accessType` value outside the allowed set, the
 * CHECK constraint creation will fail with:
 *
 *     ERROR: check constraint "chk_users_access_type" of
 *     relation "users" is violated by some row
 *
 * The migration therefore runs a pre-check that enumerates offending
 * rows and raises an actionable error BEFORE altering the table. Same
 * pattern as `EnforceCaseInsensitiveEmailUniqueness1781300000000`:
 *
 *   1. SELECT non-conforming rows
 *   2. If any exist, throw with a list of the top ~10 (user IDs)
 *   3. Operators must resolve (set to a legal value or delete the row)
 *   4. Re-run migration
 *
 * A pre-check is strictly better than letting the ALTER fail, because
 * the error message from PG doesn't list which rows violated — only
 * "some row does". That's useless in production.
 *
 * # NULL handling
 *
 * The constraint allows NULL: `accessType IS NULL OR accessType IN (...)`.
 * This matches the entity declaration (`nullable: true`) and leaves
 * pre-migration rows that had no value set alone. New writes via the
 * application layer will always set a value (the entity default is
 * `'BOTH'`), but we don't want the migration to retroactively fill in
 * NULLs — that's a semantic choice the application should make
 * deliberately, not something a DDL migration should do.
 */
export class AddUsersAccessTypeCheck1781700000000
  implements MigrationInterface
{
  name = 'AddUsersAccessTypeCheck1781700000000';
  private readonly logger = new MigrationLogger(this.name);

  private readonly constraintName = 'chk_users_access_type';
  private readonly legalValues = [
    'PANEL_ONLY',
    'MOBILE_ONLY',
    'BOTH',
  ] as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      `Adding CHECK constraint "${this.constraintName}" on users.accessType`,
    );

    // Pre-check: find any row whose accessType is non-NULL and not in the
    // legal set. If any exist, abort with an actionable error before
    // the ALTER runs, so the PG error doesn't get swallowed as a
    // generic "check constraint violated".
    const offendingRows: Array<{ id: string; accessType: string }> =
      await queryRunner.query(`
        SELECT id, "accessType"
        FROM "users"
        WHERE "accessType" IS NOT NULL
          AND "accessType" NOT IN ('PANEL_ONLY', 'MOBILE_ONLY', 'BOTH')
        ORDER BY "createdAt" DESC
        LIMIT 11
      `);

    if (offendingRows.length > 0) {
      // Cap at 10 for log readability; the 11th (if present) is the
      // "... and N more" indicator.
      const shown = offendingRows.slice(0, 10);
      const rest = offendingRows.length > 10 ? 'one or more' : '0';
      const list = shown
        .map((r) => `  - id=${r.id} accessType="${r.accessType}"`)
        .join('\n');

      throw new Error(
        `Refusing to install CHECK constraint: ${offendingRows.length} ` +
          `user(s) have an accessType outside the legal set. ` +
          `Resolve (set to 'PANEL_ONLY' / 'MOBILE_ONLY' / 'BOTH' / NULL) ` +
          `before re-running.\n` +
          `Affected rows:\n${list}\n` +
          `... and ${rest} more` +
          (offendingRows.length > 10 ? '' : ' (truncated at 10)'),
      );
    }

    // Idempotency: if the constraint already exists, `ADD CONSTRAINT`
    // raises `duplicate_object`. We check first so re-running the
    // migration on an environment where it was already applied is a
    // no-op instead of an error.
    const existsRows: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'users'
          AND c.conname = $1
      ) AS exists
      `,
      [this.constraintName],
    );

    if (existsRows[0]?.exists === true) {
      this.logger.log(
        `CHECK constraint "${this.constraintName}" already exists — skipping`,
      );
      return;
    }

    // Add the constraint. NOT VALID would let us defer validation of
    // existing rows, but we just proved there are no offending rows
    // via the pre-check — there's no benefit to NOT VALID here.
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "${this.constraintName}"
      CHECK ("accessType" IS NULL OR "accessType" IN ('PANEL_ONLY', 'MOBILE_ONLY', 'BOTH'))
    `);

    this.logger.log(
      `CHECK constraint "${this.constraintName}" installed on users.accessType`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      `Dropping CHECK constraint "${this.constraintName}" — users.accessType ` +
        `will lose database-level validation. New writes with unknown values ` +
        `will succeed silently and cause runtime routing bugs.`,
    );

    await queryRunner.query(`
      ALTER TABLE "users"
      DROP CONSTRAINT IF EXISTS "${this.constraintName}"
    `);
  }
}
