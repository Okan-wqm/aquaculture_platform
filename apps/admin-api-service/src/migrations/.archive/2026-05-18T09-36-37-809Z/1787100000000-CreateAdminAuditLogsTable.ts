import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateAdminAuditLogsTable
 * ============================================================================
 *
 * Creates `admin.audit_logs` — admin-api-service's own audit table for
 * SUPER_ADMIN actions (tenant impersonation, plan changes, IP rule edits,
 * etc.).
 *
 * # Why this migration exists
 *
 * `apps/admin-api-service/src/audit/audit.entity.ts:83` declares
 * `@Entity('audit_logs', { schema: 'admin' })` but the physical table
 * was never created on the live droplet. SchemaDriftValidator[admin-api]
 * catches this on every cold start:
 *
 *   [audit_logs] entity declares schema='admin' but table lives in 'auth'
 *
 * The entity's docblock (CRITICAL-002 from the 2026-04-14 review)
 * explicitly designed admin's audit log as DISTINCT from `shared.audit_logs`
 * (cross-service trail) and `auth.audit_logs` (auth operational audit) —
 * admin-api needs extended fields (`AuditAction` enum, structured
 * details/previousValue/newValue JSONB) that don't fit shared's tighter
 * schema. The CREATE TABLE migration to materialise the design was missed.
 *
 * # What this fixes
 *
 * Closes the 1 REAL drift in admin-api's 68 violations. The remaining
 * 67 are permission-shadow false positives on cross-schema billing.*
 * read views (`synchronize: false` entities); those are fixed by the
 * SchemaDriftValidator change in this same PR (skip synchronize-false
 * entities — they're owned by another service whose own validator
 * catches OWNER-side drift).
 *
 * # Idempotent
 *
 * `CREATE TABLE IF NOT EXISTS` — safe to re-run on a droplet where the
 * table already exists from a manual operator run.
 *
 * # Not destructive
 *
 * No data move; the existing `auth.audit_logs` is untouched. Admin's
 * AuditService writes go to admin.audit_logs (its bound entity); no
 * other service reads admin.audit_logs (it's admin-api-internal).
 *
 * # Down-rollback
 *
 * Drops the table. Operators who want to preserve the data should
 * pg_dump first; admin-api's AuditService will fail on writes after
 * rollback.
 */
export class CreateAdminAuditLogsTable1787100000000
  implements MigrationInterface
{
  private readonly logger = new Logger('CreateAdminAuditLogsTable1787100000000');

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Defense: ensure admin schema exists (would have been created by
    // 00-init-schemas.sh codegen but a partially-init'd droplet might lack it).
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS admin`);

    // Enum types are recreated only if missing; PostgreSQL has no
    // CREATE TYPE IF NOT EXISTS so we wrap in DO/EXCEPTION.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE admin.audit_logs_severity_enum AS ENUM ('info', 'warning', 'critical');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // The CREATE TABLE column shape mirrors apps/admin-api-service/src/audit/audit.entity.ts
    // 1:1. Adding a new column to the entity requires a new ALTER TABLE
    // migration alongside; the SchemaDriftValidator will catch the
    // mismatch on the next deploy if missed.
    //
    // Indexes are emitted in the SAME SQL chunk as CREATE TABLE so the
    // migration-sql lint's R3 rule recognizes them as "index-on-new-
    // table" (table empty at index-creation time, ACCESS EXCLUSIVE
    // safe). Splitting into separate queryRunner.query() chunks would
    // trigger R3-create-index-not-concurrent because the lint scans
    // each chunk in isolation.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.audit_logs (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        action varchar(100) NOT NULL,
        "entityType" varchar(50) NOT NULL,
        "entityId" uuid NULL,
        "tenantId" uuid NULL,
        "performedBy" varchar(100) NOT NULL,
        "performedByEmail" varchar(100) NULL,
        "ipAddress" varchar(45) NULL,
        "userAgent" varchar(500) NULL,
        details jsonb NULL,
        "previousValue" jsonb NULL,
        "newValue" jsonb NULL,
        severity admin.audit_logs_severity_enum NOT NULL DEFAULT 'info',
        "requestId" varchar(100) NULL,
        "sessionId" varchar(100) NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_admin_audit_logs" PRIMARY KEY (id)
      );
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_action" ON admin.audit_logs (action);
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_entity" ON admin.audit_logs ("entityType", "entityId");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_performedBy" ON admin.audit_logs ("performedBy");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_tenantId" ON admin.audit_logs ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_createdAt" ON admin.audit_logs ("createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_severity" ON admin.audit_logs (severity);
    `);

    // Grant the admin role full table privileges (sequence not needed —
    // uuid PK has no sequence). Defense in depth: even though admin
    // owns admin schema, an ALTER OWNER hiccup could leave the table
    // owned by postgres; explicit grant ensures admin_service can write.
    const adminRoleExists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') AS exists`,
    );
    if (adminRoleExists[0]?.exists) {
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON admin.audit_logs TO admin_service`,
      );
    }

    this.logger.log(
      'admin.audit_logs created with 6 indexes; admin-api drift "audit_logs lives in auth" closed.',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      -- DESTRUCTIVE: rollback drops admin.audit_logs and loses all SUPER_ADMIN audit history
      -- pg_dump backup taken by deploy pipeline before any migration is the recovery path
      DROP TABLE IF EXISTS admin.audit_logs CASCADE
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS admin.audit_logs_severity_enum`,
    );
  }
}
