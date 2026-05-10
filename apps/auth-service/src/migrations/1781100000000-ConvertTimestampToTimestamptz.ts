import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * ConvertTimestampToTimestamptz1781100000000
 * ============================================================================
 *
 * Converts every `TIMESTAMP WITHOUT TIME ZONE` column in the auth schema to
 * `TIMESTAMPTZ` (`TIMESTAMP WITH TIME ZONE`).
 *
 * # Why
 *
 * The `database-design:postgresql` skill (and every serious PostgreSQL
 * guide) calls `TIMESTAMP WITHOUT TIME ZONE` a footgun: it stores a
 * wall-clock value with no timezone metadata, so the interpretation
 * depends entirely on whoever reads it later. In a multi-tenant SaaS
 * where services run in containers pinned to UTC while users live across
 * timezones, that interpretation drifts the moment anyone touches the
 * data from a non-UTC session, and breaks badly across DST transitions.
 *
 * Concretely, these columns control **security-sensitive TTLs**:
 *   - `users.lockedUntil`, `users.mfaLockedUntil` — account lockout windows
 *   - `users.invitationExpiresAt`, `users.passwordResetExpires` — token TTLs
 *   - `refresh_tokens.expiresAt`, `refresh_tokens.revokedAt` — session lifetime
 *   - `invitations.expiresAt` — invitation lifetime
 *
 * A ±1 hour drift during a DST transition means a lockout is either
 * enforced an hour too long (UX issue) or released an hour too early
 * (SECURITY issue — brute-force retry window opens early). Same risk
 * applies to invitation tokens outliving their intended window.
 *
 * # Conversion semantics
 *
 * `ALTER COLUMN ... TYPE TIMESTAMPTZ USING col AT TIME ZONE 'UTC'`
 *
 * reads every existing row's wall-clock value AS IF it were recorded in
 * UTC and stamps it as a UTC instant. This is the only safe default
 * because:
 *
 * 1. The application writes timestamps via `new Date()` in Node.js, which
 *    produces wall-clock values in the process TZ. All our containers
 *    are pinned to UTC (`TZ=UTC` in Dockerfile base), so the writer's
 *    wall-clock is already UTC.
 * 2. PostgreSQL session `TimeZone` GUC defaults to `UTC` in our
 *    connection config. TypeORM does not override this.
 * 3. Therefore the existing TIMESTAMP values in auth.* tables are
 *    effectively already-UTC wall-clock strings, and re-stamping them
 *    with `AT TIME ZONE 'UTC'` is a no-op semantically but correct
 *    operationally.
 *
 * If this assumption is wrong for any environment (e.g. a legacy staging
 * DB that was populated with localtime), the down() migration below
 * reverts to the original type. Verify with:
 *
 *   SELECT name, setting FROM pg_settings WHERE name = 'TimeZone';
 *
 * before running this in production.
 *
 * # Locking
 *
 * `ALTER COLUMN TYPE` acquires an `ACCESS EXCLUSIVE` lock and **rewrites
 * the table**. Auth schema tables are small (`users` ~10K rows at most,
 * `refresh_tokens` a few × users, the rest tiny), so the rewrite
 * completes in well under a second and the lock window is acceptable
 * during a normal deploy.
 *
 * If any of these tables ever grow past ~1M rows, switch to the
 * add-new-column-backfill-swap pattern (see PostgreSQL Wiki, "Changing a
 * column's type with minimal downtime").
 *
 * # Why one migration for 25 columns?
 *
 * The alternative — 25 separate migrations — would fragment the rollback
 * path. A single migration either succeeds (all 25 columns converted) or
 * rolls back cleanly. No half-converted schema state is possible.
 *
 * Migration runtime: fastest path is one ALTER TABLE per table (with
 * multiple ALTER COLUMN clauses), not one per column. PostgreSQL's
 * planner consolidates the rewrites when they're in the same statement,
 * so a 5-column ALTER on `users` is one rewrite pass, not five.
 */
export class ConvertTimestampToTimestamptz1781100000000
  implements MigrationInterface
{
  name = 'ConvertTimestampToTimestamptz1781100000000';
  private readonly logger = new MigrationLogger(this.name);

  /**
   * Table → columns map. Order matches the audit inventory in the C-1
   * finding report. Each entry becomes one `ALTER TABLE ... ALTER COLUMN
   * ... TYPE ... USING ... AT TIME ZONE 'UTC'` statement, with all
   * columns folded into a single statement per table so the rewrite
   * happens once.
   */
  private readonly conversions: ReadonlyArray<{
    table: string;
    columns: readonly string[];
  }> = [
    {
      table: 'users',
      columns: [
        'invitationExpiresAt',
        'mfaLockedUntil',
        'lastLoginAt',
        'passwordResetExpires',
        'lockedUntil',
      ],
    },
    {
      table: 'invitations',
      columns: ['expiresAt', 'acceptedAt', 'lastSentAt'],
    },
    {
      table: 'refresh_tokens',
      columns: ['expiresAt', 'revokedAt'],
    },
    {
      table: 'user_module_assignments',
      columns: ['expiresAt'],
    },
    {
      table: 'webauthn_credentials',
      columns: ['lastUsedAt'],
    },
    {
      table: 'tenants',
      columns: ['trialEndsAt', 'subscriptionEndsAt'],
    },
    {
      table: 'tenant_modules',
      columns: ['activatedAt', 'expiresAt'],
    },
    {
      table: 'announcements',
      columns: ['publishAt', 'expiresAt'],
    },
    {
      table: 'announcement_acknowledgments',
      columns: ['acknowledgedAt'],
    },
    {
      table: 'message_threads',
      columns: ['lastMessageAt'],
    },
    {
      table: 'messages',
      columns: ['readAt'],
    },
    {
      table: 'support_tickets',
      columns: [
        'slaResponseDeadline',
        'slaResolutionDeadline',
        'firstResponseAt',
        'resolvedAt',
      ],
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      `Converting up to ${this.totalColumnCount()} timestamp columns across ${this.conversions.length} tables to TIMESTAMPTZ`,
    );

    // Capture the session TimeZone GUC as an audit artefact. If it's not
    // 'UTC' the USING clause will still work (PostgreSQL always
    // interprets AT TIME ZONE 'UTC' as UTC regardless of session TZ), but
    // an unexpected value here is a signal that the DB has unusual
    // configuration and the migration should be reviewed.
    const tzRows: Array<{ setting: string }> = await queryRunner.query(
      `SELECT setting FROM pg_settings WHERE name = 'TimeZone'`,
    );
    const sessionTz = tzRows[0]?.setting ?? 'unknown';
    this.logger.log(
      `Session TimeZone = ${sessionTz} (USING clause pins interpretation to UTC regardless)`,
    );

    let convertedTotal = 0;
    let skippedTotal = 0;

    for (const { table, columns } of this.conversions) {
      // INIT-FIX (factory-reset 2026-05-06): on a fresh-volume bootstrap the
      // init scripts produce a stale `auth.users` snapshot that pre-dates
      // several MFA / WebAuthn / announcements tables/columns. Migrations
      // that ran on the legacy DB no longer ship in the codebase, so the
      // historical "every column already exists" assumption is false on a
      // brand-new DB.
      //
      // We resolve the actual present columns from information_schema and
      // convert only those. Missing columns are logged and skipped — they
      // will be created by later migrations or entity bootstrap with the
      // correct timestamptz type from birth, so this migration's intent
      // (no plain TIMESTAMP in auth schema) is preserved either way.
      //
      // Skipping if the table itself doesn't exist (e.g. announcements,
      // message_threads, support_tickets when the auth-service ships
      // without them yet) is treated the same way — log and continue.
      const tableExistsRows: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'auth' AND table_name = $1
         ) AS exists`,
        [table],
      );
      const tableExists = tableExistsRows[0]?.exists === true;
      if (!tableExists) {
        this.logger.warn(
          `Skipping ${table}: auth.${table} not present on this DB; later migrations or entity bootstrap will own it.`,
        );
        skippedTotal += columns.length;
        continue;
      }

      const colRows: Array<{ column_name: string }> = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'auth' AND table_name = $1
             AND column_name = ANY($2::text[])`,
        [table, [...columns]],
      );
      const presentCols = new Set(colRows.map((r) => r.column_name));
      const present = columns.filter((c) => presentCols.has(c));
      const missing = columns.filter((c) => !presentCols.has(c));

      if (missing.length > 0) {
        this.logger.warn(
          `Skipping non-existent columns on auth.${table}: ${missing.join(', ')} (covered by later migrations or entity bootstrap)`,
        );
        skippedTotal += missing.length;
      }

      if (present.length === 0) {
        this.logger.warn(`No matching columns to convert on auth.${table}; skipping table.`);
        continue;
      }

      // Build a single ALTER TABLE with one ALTER COLUMN per target.
      // PostgreSQL rewrites the table once for the whole statement —
      // significantly faster than N separate ALTERs, each of which would
      // rewrite the table individually.
      //
      // NOTE: quoted "camelCase" column names are required here because
      // auth-service entities use camelCase identifiers (unlike farm-
      // service which uses snake_case via BaseEntity). Losing the quotes
      // would make PostgreSQL lowercase them and the ALTER would fail
      // with "column does not exist".
      const clauses = present
        .map(
          (col) =>
            `ALTER COLUMN "${col}" TYPE TIMESTAMPTZ USING "${col}" AT TIME ZONE 'UTC'`,
        )
        .join(', ');

      // Schema-qualify the table reference. The information_schema
      // existence check above scopes to table_schema='auth', so the ALTER
      // MUST land on the same schema. Without "auth." prefix the ALTER
      // resolves against the connection's search_path (typically `public`)
      // and fails with `relation "users" does not exist` on a fresh DB
      // where auth tables only live in the auth schema.
      const sql = `ALTER TABLE "auth"."${table}" ${clauses}`;
      this.logger.log(`Converting auth.${table}: ${present.join(', ')}`);

      await queryRunner.query(sql);
      convertedTotal += present.length;
    }

    this.logger.log(
      `auth schema timestamp conversion complete — converted=${convertedTotal} skipped=${skippedTotal}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert semantics: strip the timezone by converting back to wall-
    // clock UTC. This mirrors the up() step — the values stay numerically
    // identical but lose their explicit UTC stamp. A fresh up() after
    // down() is safe because AT TIME ZONE 'UTC' on an already-UTC wall
    // clock is idempotent.
    //
    // WARNING: running down() in production is a downgrade and should
    // only happen as part of a planned rollback. The down() direction
    // re-introduces the DST drift that motivated up() in the first
    // place, so operators should treat this as a "break glass" operation.
    this.logger.warn(
      'Reverting auth schema columns from TIMESTAMPTZ to TIMESTAMP — ' +
        'DST drift risk reintroduced. This should only happen during a ' +
        'planned rollback.',
    );

    for (const { table, columns } of this.conversions) {
      const clauses = columns
        .map(
          (col) =>
            // AT TIME ZONE 'UTC' against a timestamptz returns a
            // wall-clock timestamp in UTC — the inverse of the up()
            // direction. This preserves the numeric value on disk
            // byte-for-byte relative to the pre-up() state.
            `ALTER COLUMN "${col}" TYPE TIMESTAMP USING "${col}" AT TIME ZONE 'UTC'`,
        )
        .join(', ');

      // Schema-qualify the rollback target for the same reason as up().
      await queryRunner.query(`ALTER TABLE "auth"."${table}" ${clauses}`);
      this.logger.log(`Reverted auth.${table}: ${columns.join(', ')}`);
    }

    this.logger.log('Rollback complete — auth schema back on TIMESTAMP');
  }

  /** Total column count across the `conversions` table. Pure helper. */
  private totalColumnCount(): number {
    return this.conversions.reduce((acc, c) => acc + c.columns.length, 0);
  }
}
