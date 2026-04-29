import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateSharedAccessLogs1788400000000
 * ============================================================================
 *
 * Creates the `shared.access_logs` table — the low-level HTTP audit
 * stream the AUDITTRAIL-HIGH-004 cure requires.
 *
 * # Why this migration exists
 *
 * The audit-trail-completeness-auditor invariant calls for two
 * audit streams:
 *
 *   - shared.audit_logs (semantic-action level, 7y retention)
 *   - shared.access_logs (request level, 90d retention)
 *
 * Pre-fix only the first existed. Without access_logs, request-
 * level forensics for non-mutation reads (PII field reads via
 * background jobs, admin dashboard queries, GDPR data exports)
 * was unavailable.
 *
 * # Schema placement
 *
 * `shared` schema, alongside audit_logs / gdpr_data_requests /
 * user_consents / user_permissions. Cross-tenant by design (every
 * request ID, regardless of tenant, must remain visible to
 * platform operators).
 *
 * # Why CONCURRENTLY for indexes
 *
 * Only the table creation runs inside the default transaction
 * (CREATE TABLE is fast and locking-cheap). The four secondary
 * indexes are created CONCURRENTLY in a transaction:'none'
 * follow-up sequence so they don't stall the platform-wide
 * write path on tables with millions of rows. (At creation time
 * the table is empty so the impact is academic, but the pattern
 * matches the canonical 1788100000000-AddAuditLogShapeExtension
 * shape so future maintainers extending this schema follow the
 * same blueprint.)
 *
 * # Why NOT NULL on method/path/status/durationMs
 *
 * Every HTTP request has a method, path, status code, and
 * duration — there is no legitimate caller that would emit a
 * partial row. Forcing NOT NULL at the DB layer means a
 * malformed access-log emission fails LOUD at INSERT time
 * rather than silently persisting a useless row.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-HIGH-004
 */
export class CreateSharedAccessLogs1788400000000
  implements MigrationInterface
{
  name = 'CreateSharedAccessLogs1788400000000';

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  transaction: 'none' = 'none';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: ensure schema exists. shared was created by an
    // earlier migration (MoveSharedTablesFromAdminToShared) but
    // we use IF NOT EXISTS so this migration is idempotent on
    // partial-rollback scenarios.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS shared`);

    // Step 2: CREATE TABLE. Column shape mirrors AccessLogEntity
    // (libs/backend-common/src/audit/access-log.entity.ts) — the
    // schema-drift-validator catches drift between the two at
    // service boot.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shared.access_logs (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "method"         varchar(8)    NOT NULL,
        "path"           varchar(2048) NOT NULL,
        "status"         integer       NOT NULL,
        "durationMs"     integer       NOT NULL,
        "userId"         varchar(255),
        "tenantId"       uuid,
        "correlationId"  varchar(100),
        "ip"             inet,
        "userAgent"      varchar(500),
        "createdAt"      timestamptz   NOT NULL DEFAULT now()
      )
    `);

    // Step 3: secondary indexes (CONCURRENTLY for production-
    // safety on the future filled table). Mirror the @Index
    // declarations on AccessLogEntity.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_access_log_tenant_created"
        ON shared.access_logs ("tenantId", "createdAt" DESC)
        WHERE "tenantId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_access_log_user_created"
        ON shared.access_logs ("userId", "createdAt" DESC)
        WHERE "userId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_access_log_path_created"
        ON shared.access_logs ("path", "createdAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_access_log_status_created"
        ON shared.access_logs ("status", "createdAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first (CONCURRENTLY for symmetry), then table.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS shared."IDX_access_log_status_created"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS shared."IDX_access_log_path_created"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS shared."IDX_access_log_user_created"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS shared."IDX_access_log_tenant_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS shared.access_logs`);
  }
}
