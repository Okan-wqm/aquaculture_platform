/**
 * Database coordinates for the single admin-audit mutation authority.
 *
 * Runtime code may append qualified evidence only through the SECURITY DEFINER
 * function. Direct table INSERT/UPDATE/DELETE privileges are revoked from the
 * admin runtime role. Retention uses a different, NOLOGIN-compatible role and
 * is admitted by the DELETE trigger only after that role is explicitly assumed.
 */
export const ADMIN_AUDIT_DATABASE_AUTHORITY = Object.freeze({
  appendFunction: 'admin.append_authoritative_audit_v1',
  appendFunctionIdentity:
    'admin.append_authoritative_audit_v1(varchar,varchar,uuid,uuid,varchar,varchar,inet,varchar,jsonb,jsonb,jsonb,admin.audit_logs_severity_enum,varchar,varchar)',
  appendContextSetting: 'app.admin_audit_append_authority',
  appendContextValue: 'admin-audit-append.v1',
  runtimeRole: 'admin_service',
  retentionControllerRole: 'admin_audit_retention_controller',
} as const);

export const ADMIN_AUDIT_APPEND_SQL =
  `SELECT * FROM ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunction}(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
)` as const;
