import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * ConvertTimestampToTimestamptz1781500000000
 * ============================================================================
 *
 * Converts every `TIMESTAMP WITHOUT TIME ZONE` column in the admin-api
 * schema (`admin`) to `TIMESTAMPTZ` (`TIMESTAMP WITH TIME ZONE`).
 *
 * Companion to `ConvertTimestampToTimestamptz1781100000000` in
 * auth-service. Same rationale, same USING AT TIME ZONE 'UTC' clause,
 * same one-ALTER-per-table optimisation. See that migration's docblock
 * for the full analysis of why TIMESTAMP is a footgun and why
 * converting the existing rows as UTC instants is the correct default
 * on our UTC-pinned container fleet.
 *
 * # Scope
 *
 * admin-api-service owns three sets of entities with legacy TIMESTAMP
 * columns. This migration covers the tables that admin-api writes to;
 * read-only cross-schema references (`tenant.entity.ts` pointing at
 * `auth.tenants`) and `synchronize: false` tables
 * (`analytics-snapshot.entity.ts`) are NOT altered here because either:
 *
 *   1. The writing service already migrated them (auth-service did
 *      `auth.tenants` in migration 1781100000000), or
 *   2. admin-api does not own their schema lifecycle — another process
 *      is responsible for their DDL.
 *
 * Tables migrated:
 *
 *   database-management (admin schema):
 *     tenant_schemas          (2): lastMigrationAt, lastBackupAt
 *     schema_migrations       (2): startedAt, completedAt
 *     schema_backups          (3): startedAt, completedAt, expiresAt
 *     schema_restores         (3): pointInTimeTarget, startedAt, completedAt
 *     database_metrics        (1): recordedAt
 *     slow_query_logs         (1): recordedAt
 *
 *   security/compliance (admin schema):
 *     activity_logs           (1): archivedAt
 *     security_events         (2): assignedAt, resolvedAt
 *     security_incidents      (6): detectedAt, containedAt, eradicatedAt,
 *                                   recoveredAt, closedAt, reportedAt
 *     threat_intelligence     (4): validFrom, validUntil, lastSeenAt,
 *                                   firstSeenAt
 *     data_requests           (5): verifiedAt, dueDate, processingStartedAt,
 *                                   completedAt, downloadExpiresAt
 *     compliance_reports      (2): reportPeriodStart, reportPeriodEnd
 *     user_sessions           (3): expiresAt, lastActivityAt, terminatedAt
 *
 *   support (admin schema):
 *     message_threads         (1): lastMessageAt
 *     messages                (1): readAt
 *     announcements           (2): publishAt, expiresAt
 *     announcement_acknowledgments (2): viewedAt, acknowledgedAt
 *     support_tickets         (4): firstResponseAt, resolvedAt, closedAt, dueAt
 *     onboarding_progress     (3): welcomeEmailSentAt, startedAt, completedAt
 *
 *   Total: 48 columns across 19 tables.
 *
 * # One ALTER TABLE per table
 *
 * Each table's columns are folded into a single ALTER TABLE with
 * multiple ALTER COLUMN clauses so PostgreSQL rewrites the table
 * exactly once. admin schema tables are small (activity_logs and
 * slow_query_logs grow over time but have retention policies), so the
 * rewrite completes in at most a few seconds per table on production
 * data sizes.
 *
 * # Security-sensitive columns
 *
 *   - user_sessions.expiresAt       → session lifetime
 *   - user_sessions.lastActivityAt  → idle timeout
 *   - user_sessions.terminatedAt    → audit of forced logout
 *   - data_requests.dueDate         → GDPR compliance SLA
 *   - data_requests.downloadExpiresAt → access window for PII exports
 *   - security_incidents timeline   → incident response timing
 *
 * A ±1h DST drift on any of these is a compliance finding. The
 * conversion is urgent for exactly the same reasons as auth-service.
 *
 * # Why WITH TIME ZONE 'UTC' in the USING clause
 *
 * Our container fleet has `TZ=UTC` in the Dockerfile, Node.js
 * `new Date()` produces UTC wall-clock values, and the TypeORM
 * connection doesn't override the PostgreSQL session TimeZone GUC.
 * Therefore existing TIMESTAMP values are already-UTC wall-clock
 * strings, and re-stamping them with `AT TIME ZONE 'UTC'` is a
 * semantic no-op — correct but unchanged.
 *
 * If any non-production environment has been populated with local-
 * time data, the up() logs the session TimeZone GUC before running
 * any ALTERs so deploy logs surface that mismatch for manual review.
 */
export class ConvertTimestampToTimestamptz1781500000000
  implements MigrationInterface
{
  name = 'ConvertTimestampToTimestamptz1781500000000';
  private readonly logger = new MigrationLogger(this.name);

  /**
   * Table → columns map. Ordered by entity file for readability.
   * Each entry becomes one `ALTER TABLE ... ALTER COLUMN ... TYPE ...
   * USING ... AT TIME ZONE 'UTC'` statement.
   */
  private readonly conversions: ReadonlyArray<{
    table: string;
    columns: readonly string[];
  }> = [
    // ── database-management ────────────────────────────────────────
    {
      table: 'tenant_schemas',
      columns: ['lastMigrationAt', 'lastBackupAt'],
    },
    {
      table: 'schema_migrations',
      columns: ['startedAt', 'completedAt'],
    },
    {
      table: 'schema_backups',
      columns: ['startedAt', 'completedAt', 'expiresAt'],
    },
    {
      table: 'schema_restores',
      columns: ['pointInTimeTarget', 'startedAt', 'completedAt'],
    },
    {
      table: 'database_metrics',
      columns: ['recordedAt'],
    },
    {
      table: 'slow_query_logs',
      columns: ['recordedAt'],
    },
    // ── security/compliance ────────────────────────────────────────
    {
      table: 'activity_logs',
      columns: ['archivedAt'],
    },
    {
      table: 'security_events',
      columns: ['assignedAt', 'resolvedAt'],
    },
    {
      table: 'security_incidents',
      columns: [
        'detectedAt',
        'containedAt',
        'eradicatedAt',
        'recoveredAt',
        'closedAt',
        'reportedAt',
      ],
    },
    {
      table: 'threat_intelligence',
      columns: ['validFrom', 'validUntil', 'lastSeenAt', 'firstSeenAt'],
    },
    {
      table: 'data_requests',
      columns: [
        'verifiedAt',
        'dueDate',
        'processingStartedAt',
        'completedAt',
        'downloadExpiresAt',
      ],
    },
    {
      table: 'compliance_reports',
      columns: ['reportPeriodStart', 'reportPeriodEnd'],
    },
    {
      table: 'user_sessions',
      columns: ['expiresAt', 'lastActivityAt', 'terminatedAt'],
    },
    // ── support ────────────────────────────────────────────────────
    {
      table: 'message_threads',
      columns: ['lastMessageAt'],
    },
    {
      table: 'messages',
      columns: ['readAt'],
    },
    {
      table: 'announcements',
      columns: ['publishAt', 'expiresAt'],
    },
    {
      table: 'announcement_acknowledgments',
      columns: ['viewedAt', 'acknowledgedAt'],
    },
    {
      table: 'support_tickets',
      columns: ['firstResponseAt', 'resolvedAt', 'closedAt', 'dueAt'],
    },
    {
      table: 'onboarding_progress',
      columns: ['welcomeEmailSentAt', 'startedAt', 'completedAt'],
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      `Converting ${this.totalColumnCount()} timestamp columns across ${this.conversions.length} tables to TIMESTAMPTZ`,
    );

    // Audit: surface the session TimeZone GUC so any non-UTC environment
    // is visible in deploy logs. The USING clause always pins
    // interpretation to UTC regardless, but an unexpected session TZ is
    // a signal that the operator should review before running.
    const tzRows: Array<{ setting: string }> = await queryRunner.query(
      `SELECT setting FROM pg_settings WHERE name = 'TimeZone'`,
    );
    const sessionTz = tzRows[0]?.setting ?? 'unknown';
    this.logger.log(
      `Session TimeZone = ${sessionTz} (USING AT TIME ZONE 'UTC' pins interpretation regardless)`,
    );

    for (const { table, columns } of this.conversions) {
      // Gracefully skip tables that do not exist in this environment.
      // admin-api has a large inventory of tables that may not be
      // provisioned on every install (e.g. dev environments may not have
      // compliance_reports if the compliance module wasn't seeded). We
      // check existence before attempting the ALTER so the migration
      // doesn't hard-fail on optional modules.
      const tableExists = await this.tableExistsInCurrentSchema(
        queryRunner,
        table,
      );

      if (!tableExists) {
        this.logger.warn(
          `Table ${table} not present in current schema — skipping ` +
            `(optional module may not be provisioned)`,
        );
        continue;
      }

      // Build a single ALTER TABLE with one ALTER COLUMN per target.
      // PostgreSQL rewrites the table once for the whole statement.
      // Quoted "camelCase" column names match the TypeORM default.
      const clauses = columns
        .map(
          (col) =>
            `ALTER COLUMN "${col}" TYPE TIMESTAMPTZ USING "${col}" AT TIME ZONE 'UTC'`,
        )
        .join(', ');

      this.logger.log(`Converting ${table}: ${columns.join(', ')}`);
      await queryRunner.query(`ALTER TABLE "${table}" ${clauses}`);
    }

    this.logger.log('admin schema timestamp columns converted to TIMESTAMPTZ');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting admin schema columns from TIMESTAMPTZ to TIMESTAMP — ' +
        'DST drift risk reintroduced across session, compliance, and ' +
        'incident-response tables. Break-glass operation only.',
    );

    for (const { table, columns } of this.conversions) {
      const tableExists = await this.tableExistsInCurrentSchema(
        queryRunner,
        table,
      );
      if (!tableExists) continue;

      const clauses = columns
        .map(
          (col) =>
            // Inverse of up(): strip timezone by converting back to a
            // wall-clock timestamp in UTC. Byte-identical with the
            // pre-up() state on UTC-pinned containers.
            `ALTER COLUMN "${col}" TYPE TIMESTAMP USING "${col}" AT TIME ZONE 'UTC'`,
        )
        .join(', ');

      await queryRunner.query(`ALTER TABLE "${table}" ${clauses}`);
      this.logger.log(`Reverted ${table}: ${columns.join(', ')}`);
    }

    this.logger.log('Rollback complete — admin schema back on TIMESTAMP');
  }

  /**
   * Check whether a base table exists in the current schema. Uses
   * information_schema so the check is schema-aware (it follows the
   * migration runner's search_path).
   */
  private async tableExistsInCurrentSchema(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND table_type = 'BASE TABLE'
      ) AS exists
      `,
      [tableName],
    );
    return rows[0]?.exists === true;
  }

  /** Sum of columns across all conversion entries — pure helper. */
  private totalColumnCount(): number {
    return this.conversions.reduce((acc, c) => acc + c.columns.length, 0);
  }
}
