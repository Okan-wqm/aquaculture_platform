import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RestoreSharedAccessLogs1801600000000
 * ============================================================================
 *
 * Restores `shared.access_logs`, which the 2026-05-18 migration squash dropped
 * while every other layer kept declaring it.
 *
 * # What the platform believed vs what it had
 *
 * Four layers still reference this table:
 *
 *   - `AccessLogMiddleware` writes a row per request, and it is wired into
 *     `gateway-api`'s app module and `admin-api-service`'s retention bootstrap;
 *   - `AccessLogEntity` maps it for runtime read/write;
 *   - `protected-tables.ts` lists `shared.access_logs` as protected;
 *   - the RLS infrastructure-ledger SSoT declares `shared: [audit_logs,
 *     access_logs]`.
 *
 * `CreateSharedAccessLogs1788400000000` created it. The squash into
 * `Baseline1800000000000` did not carry it forward, and the archived file is
 * never applied — `migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}']`
 * neither matches a dot-directory nor descends into one. So a freshly migrated
 * deployment has request middleware writing to a table that does not exist,
 * while four SSoTs assert it does.
 *
 * The invariant that guards the table's shape,
 * `tests/invariants/access-log-stream-shape.spec.ts`, could not report this: it
 * read the migration by hardcoded filename, so the squash turned it into a
 * suite that fails to LOAD (ENOENT) rather than one that says the table is
 * gone. It was dormant, so nobody saw even that. ORPHAN-CRITICAL-516.
 *
 * # Forward-only, and idempotent
 *
 * A new migration rather than an edit to the baseline, per the never-hand-edit
 * rule. Every statement is `IF NOT EXISTS`, so an environment that still has the
 * table is unaffected.
 *
 * Closes: docs/reviews/2026-07-26-aria-codex-audit-verification.md#ORPHAN-CRITICAL-516
 */
export class RestoreSharedAccessLogs1801600000000 implements MigrationInterface {
  name = 'RestoreSharedAccessLogs1801600000000';

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS shared`);

    // Column shape mirrors AccessLogEntity
    // (libs/backend-common/src/audit/access-log.entity.ts). Drift between the
    // two is caught by SchemaDriftValidator at service boot; the coherence of
    // entity, DTO, migration and middleware is caught before merge by
    // tests/invariants/access-log-stream-shape.spec.ts.
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

    // CONCURRENTLY for production safety on a table that fills continuously.
    // Mirrors the @Index declarations on AccessLogEntity.
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
