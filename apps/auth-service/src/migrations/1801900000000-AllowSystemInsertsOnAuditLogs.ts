import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AllowSystemInsertsOnAuditLogs1801900000000 (ORPHAN-HIGH-308)
 *
 * WHY: `auth.audit_logs` carries the standard FORCED `tenant_isolation_policy`
 * (`app.bypass_rls = 'on' OR "tenantId" = app.current_tenant`). Security audit
 * rows, however, are SYSTEM-authored and must be writable from PRE-AUTH code
 * paths where no tenant context exists yet — login success/failure, account
 * lockout, locked-account attempts — and for platform-level SUPER_ADMIN actors
 * whose rows carry `tenantId = NULL` (which can never satisfy the tenant
 * predicate). In production every one of those INSERTs failed with
 * `new row violates row-level security policy for table "audit_logs"` and the
 * error was swallowed as best-effort: the ENTIRE authentication audit trail
 * (LOGIN_SUCCESS, LOGIN_FAILED, LOGIN_BLOCKED_ACCOUNT_LOCKED, …) was silently
 * lost — exactly the rows a SOC-2 / forensic review needs (CC4).
 *
 * The RLS installer's own design intent (`applyTenantRlsToSchema`
 * excludeTables doc: "typically outbox, audit logs, and any deliberately
 * cross-tenant infrastructure tables") was to keep such tables out of tenant
 * RLS entirely; the auth migrations never excluded this one.
 *
 * WHAT: an ADDITIVE, INSERT-only permissive policy. PostgreSQL ORs permissive
 * policies per command, so:
 *   - INSERT: allowed unconditionally (append-only system writes succeed
 *     with or without tenant context — the write path is service-internal,
 *     rows are constructed by AuditLogService from its own DTO).
 *   - SELECT / UPDATE / DELETE: still governed ONLY by
 *     `tenant_isolation_policy` — tenant-scoped reads and the
 *     tamper-protection posture (no cross-tenant mutation without the
 *     audited bypass) are unchanged.
 *
 * Blue-green safe: additive policy, no shape change, old and new code both
 * work before and after.
 *
 * Idempotent via DROP POLICY IF EXISTS before CREATE.
 */
export class AllowSystemInsertsOnAuditLogs1801900000000 implements MigrationInterface {
  name = 'AllowSystemInsertsOnAuditLogs1801900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS "audit_append_system" ON "auth"."audit_logs"`,
    );
    await queryRunner.query(
      `CREATE POLICY "audit_append_system" ON "auth"."audit_logs" FOR INSERT WITH CHECK (true)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS "audit_append_system" ON "auth"."audit_logs"`,
    );
  }
}
