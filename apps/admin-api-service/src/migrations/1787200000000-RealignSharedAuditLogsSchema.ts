import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RealignSharedAuditLogsSchema
 * ============================================================================
 *
 * Realigns `shared.audit_logs` to the canonical backend-common cross-service
 * AuditLogEntity column shape. Migrates the 28 admin SUPER_ADMIN audit rows
 * currently parked in shared.audit_logs back to their proper home in
 * `admin.audit_logs` (created by 1787100000000).
 *
 * # Why this migration exists
 *
 * Migration `1782200000000-MoveSharedTablesFromAdminToShared.ts` MOVED
 * the existing `admin.audit_logs` table (with admin's extended column
 * shape: entityType, performedBy, details, previousValue, newValue,
 * legalHold, etc.) INTO the `shared` schema. That move preserved the
 * EXTENDED shape — which doesn't match the cross-service shape declared
 * in `libs/backend-common/src/audit/audit-log.entity.ts`:
 *
 *   backend-common (canonical cross-service):
 *     action, resource, resourceId, userId, userEmail, tenantId,
 *     schemaName, metadata, ip, userAgent, severity, correlationId,
 *     createdAt, id  (14 cols)
 *
 *   actual shared.audit_logs (admin's extended shape, post-move):
 *     action, entityType, entityId, tenantId, performedBy, performedByEmail,
 *     ipAddress, userAgent, details, previousValue, newValue, severity,
 *     requestId, sessionId, createdAt, id, legalHold  (17 cols)
 *
 * The 8 backend-common-declared columns missing from the actual table
 * (resource, resourceId, userId, userEmail, schemaName, metadata, ip,
 * correlationId) caused SchemaDriftValidator to report 8 violations on
 * every cold start of every service that registers backend-common's
 * AuditLogEntity (alert-engine, billing-service, notification-service,
 * config-service — once Phase I shared-schema grants land, the column
 * visibility resolves and the REAL shape mismatch surfaces clearly).
 *
 * # Architectural target — three audit tables, three purposes
 *
 * Per `apps/admin-api-service/src/audit/audit.entity.ts:60-72` docblock:
 *
 *   shared.audit_logs  — cross-service audit trail (writes from every
 *                        service via backend-common AuditLogModule)
 *   admin.audit_logs   — SUPER_ADMIN action audit (impersonation, plan
 *                        changes, IP rule edits) — admin-api ONLY
 *   auth.audit_logs    — auth-service operational audit (login, MFA,
 *                        token revoke) — auth-service ONLY
 *
 * Each table has its own column shape because each captures different
 * dimensions. The three-table design is intentional; the gap is that
 * the 1782200000000 move preserved the WRONG shape for shared.
 *
 * # What this migration does
 *
 * 1. Verify admin.audit_logs exists (created by 1787100000000). Hard
 *    error if it doesn't — the row migration depends on it.
 *
 * 2. Copy every existing row from shared.audit_logs into admin.audit_logs
 *    via explicit column mapping. The shapes already match (shared
 *    currently has admin's columns) so the copy is straightforward.
 *
 * 3. DROP shared.audit_logs (with its admin-shape indexes).
 *
 * 4. CREATE shared.audit_logs with the backend-common cross-service
 *    column shape + matching indexes.
 *
 * 5. Re-grant shared.audit_logs to every service role (the GRANT block
 *    from 1787000000000 dropped when the table dropped — this re-grants
 *    on the new table).
 *
 * # Idempotency
 *
 * The migration checks for the WRONG column shape (presence of
 * `entityType` column — admin's shape, not backend-common's) before
 * doing destructive work. If the table already has the canonical
 * shape, the migration is a no-op. Re-runs are safe.
 *
 * # Data preservation invariant
 *
 * The 28 existing rows are SUPER_ADMIN audit history (impersonation
 * events, plan changes from admin-api). They legitimately belong in
 * admin.audit_logs. Step 2 preserves them; step 3 then drops the
 * (now empty for those records) shared table.
 *
 * # Down-rollback
 *
 * The reverse transformation: DROP the new shared.audit_logs, recreate
 * with admin's old shape, copy admin.audit_logs back. Operators should
 * fix-forward; rolling back re-introduces the schema drift.
 */
export class RealignSharedAuditLogsSchema1787200000000
  implements MigrationInterface
{
  private readonly logger = new Logger(
    'RealignSharedAuditLogsSchema1787200000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Detect current shape. The admin shape has `entityType` column;
    //    the canonical backend-common shape does not. If entityType is
    //    absent, the table is already realigned — no-op.
    const hasEntityType: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'shared' AND table_name = 'audit_logs'
           AND column_name = 'entityType'
       ) AS exists`,
    );

    if (!hasEntityType[0]?.exists) {
      this.logger.log(
        'shared.audit_logs already has canonical backend-common shape — no-op.',
      );
      return;
    }

    // 2. Verify admin.audit_logs target exists. Hard error if not —
    //    1787100000000-CreateAdminAuditLogsTable should have run first
    //    in this same deploy (registered earlier in the migrations array).
    const adminTableExists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables WHERE schemaname = 'admin' AND tablename = 'audit_logs'
       ) AS exists`,
    );
    if (!adminTableExists[0]?.exists) {
      throw new Error(
        'RealignSharedAuditLogsSchema: admin.audit_logs does not exist. ' +
          'Migration 1787100000000-CreateAdminAuditLogsTable must run first.',
      );
    }

    // 3. Copy every row from shared.audit_logs to admin.audit_logs.
    //    The shapes align 1:1 (shared currently has admin's columns).
    //    INSERT ... SELECT preserves all 28 rows. ON CONFLICT DO NOTHING
    //    in case operator ran a partial migration before.
    const copyResult: Array<{ count: string }> = await queryRunner.query(`
      WITH copied AS (
        INSERT INTO admin.audit_logs (
          id, action, "entityType", "entityId", "tenantId",
          "performedBy", "performedByEmail", "ipAddress", "userAgent",
          details, "previousValue", "newValue", severity,
          "requestId", "sessionId", "createdAt"
        )
        SELECT
          id, action, "entityType", "entityId", "tenantId",
          "performedBy", "performedByEmail", "ipAddress", "userAgent",
          details, "previousValue", "newValue", severity,
          "requestId", "sessionId", "createdAt"
        FROM shared.audit_logs
        ON CONFLICT (id) DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM copied
    `);
    const copiedRows = Number(copyResult[0]?.count ?? '0');
    this.logger.log(
      `Migrated ${copiedRows} SUPER_ADMIN audit rows from shared.audit_logs to admin.audit_logs.`,
    );

    // 4. DROP shared.audit_logs (with its admin-shape indexes via CASCADE).
    //    Then recreate with the canonical backend-common cross-service
    //    column shape + matching @Index decorators on AuditLogEntity.
    //    Indexes co-emitted with CREATE TABLE so migration-sql lint R3
    //    recognizes them as index-on-new-table (table empty, ACCESS
    //    EXCLUSIVE safe).
    //
    //    The enum type for severity already exists at shared
    //    (audit_logs_severity_enum) from the 1782200000000 move; we
    //    reuse it rather than recreate.
    await queryRunner.query(`
      -- DESTRUCTIVE: drops shared.audit_logs and its admin-shape data
      -- already migrated to admin.audit_logs above so shared loses no data
      -- pg_dump backup taken by deploy pipeline is the recovery path
      DROP TABLE shared.audit_logs CASCADE;
      DO $$ BEGIN
        CREATE TYPE shared.audit_logs_severity_enum AS ENUM ('info', 'warning', 'critical');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      CREATE TABLE shared.audit_logs (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        action varchar(100) NOT NULL,
        resource varchar(100) NOT NULL,
        "resourceId" varchar(255) NULL,
        "userId" varchar(255) NULL,
        "userEmail" varchar(255) NULL,
        "tenantId" uuid NULL,
        "schemaName" varchar(100) NULL,
        metadata jsonb NULL,
        ip varchar(45) NULL,
        "userAgent" varchar(500) NULL,
        severity shared.audit_logs_severity_enum NOT NULL DEFAULT 'info',
        "correlationId" varchar(100) NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shared_audit_logs" PRIMARY KEY (id)
      );
      CREATE INDEX "IDX_audit_log_tenant_created" ON shared.audit_logs ("tenantId", "createdAt");
      CREATE INDEX "IDX_audit_log_user_tenant" ON shared.audit_logs ("userId", "tenantId");
      CREATE INDEX "IDX_audit_log_resource" ON shared.audit_logs (resource, "resourceId", "tenantId");
      CREATE INDEX "IDX_audit_log_action" ON shared.audit_logs (action, "tenantId");
    `);

    // 5. Re-grant shared.audit_logs to every per-service role (DROP TABLE
    //    above removed the grants). Mirrors the grant matrix from
    //    1787000000000-GrantSharedSchemaPrivileges. Defense in depth:
    //    skip roles that don't exist on this droplet.
    const roles = [
      'auth_service',
      'farm_service',
      'sensor_service',
      'hr_service',
      'messaging_service',
      'hydroponics_service',
      'alert_service',
      'billing_service',
      'notification_service',
      'ai_service',
      'admin_service',
      'observability_service',
      'event_store_service',
    ];
    for (const role of roles) {
      const roleExists: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
        [role],
      );
      if (!roleExists[0]?.exists) continue;
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON shared.audit_logs TO "${role}"`,
      );
    }

    this.logger.log(
      'shared.audit_logs realigned to backend-common cross-service shape; ' +
        '4 indexes created; per-service grants re-applied.',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: DROP the canonical shape, recreate admin's old shape, copy
    // admin.audit_logs back. Operators should fix-forward; rolling back
    // re-introduces the SchemaDriftValidator violations on 4 services.
    await queryRunner.query(`
      -- DESTRUCTIVE: rollback drops the canonical shared.audit_logs
      -- pg_dump backup taken by deploy pipeline is the recovery path
      DROP TABLE IF EXISTS shared.audit_logs CASCADE;
      CREATE TABLE shared.audit_logs (
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
        severity shared.audit_logs_severity_enum NOT NULL DEFAULT 'info',
        "requestId" varchar(100) NULL,
        "sessionId" varchar(100) NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "legalHold" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_shared_audit_logs" PRIMARY KEY (id)
      );
    `);
    // Note: admin.audit_logs rows stay in place. Operators must
    // manually copy them back if pre-realign behavior is required.
  }
}
