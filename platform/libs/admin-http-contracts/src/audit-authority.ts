/**
 * Browser-safe authority for the immutable admin audit stream.
 *
 * An audit action is not just a display label. Its write policy determines
 * whether the business mutation and evidence must share a transaction,
 * whether evidence must commit before sensitive bytes are disclosed, or
 * whether a failure may be reduced to telemetry. Keeping policy, severity and
 * lifecycle on the action prevents call sites from silently choosing weaker
 * semantics.
 */

export const ADMIN_AUDIT_AUTHORITY_SCHEMA_VERSION = 'admin-audit-authority.v1' as const;

export const ADMIN_AUDIT_TRUST_CLASSES = ['AUTHORITATIVE_RUNTIME', 'LEGACY_UNVERIFIED'] as const;

export const ADMIN_AUDIT_TRUST_CLASS = Object.freeze({
  AUTHORITATIVE_RUNTIME: ADMIN_AUDIT_TRUST_CLASSES[0],
  LEGACY_UNVERIFIED: ADMIN_AUDIT_TRUST_CLASSES[1],
} as const);

export type AdminAuditTrustClass = (typeof ADMIN_AUDIT_TRUST_CLASSES)[number];

export const ADMIN_AUDIT_HTTP_ROUTES = Object.freeze({
  QUERY: 'GET /audit-logs',
  ENTITY_HISTORY: 'GET /audit-logs/entity/:entityType/:entityId',
  USER_ACTIVITY: 'GET /audit-logs/user/:userId',
  SECURITY: 'GET /audit-logs/security',
  STATISTICS: 'GET /audit-logs/statistics',
  EXPORT: 'POST /audit-logs/export',
} as const);

export type AdminAuditHttpRoute =
  (typeof ADMIN_AUDIT_HTTP_ROUTES)[keyof typeof ADMIN_AUDIT_HTTP_ROUTES];

export const ADMIN_AUDIT_LEGACY_PROVENANCE_SCHEMA_VERSION =
  'admin-audit-legacy-provenance.v1' as const;

export const ADMIN_AUDIT_LEGACY_SOURCES = [
  'admin.audit_logs.pretrust',
  'admin.activity_logs',
  'admin.tenant_activities',
  'admin.retention_policies',
] as const;

export const ADMIN_AUDIT_LEGACY_SOURCE = Object.freeze({
  PRETRUST_AUDIT_LOGS: ADMIN_AUDIT_LEGACY_SOURCES[0],
  ACTIVITY_LOGS: ADMIN_AUDIT_LEGACY_SOURCES[1],
  TENANT_ACTIVITIES: ADMIN_AUDIT_LEGACY_SOURCES[2],
  RETENTION_POLICIES: ADMIN_AUDIT_LEGACY_SOURCES[3],
} as const);

export type AdminAuditLegacySource = (typeof ADMIN_AUDIT_LEGACY_SOURCES)[number];

export interface AdminAuditLegacyProvenanceV1 {
  readonly schemaVersion: typeof ADMIN_AUDIT_LEGACY_PROVENANCE_SCHEMA_VERSION;
  readonly sourceAuthority: AdminAuditLegacySource;
  readonly sourceRowId: string;
  readonly sourceRowSha256: string;
  /** Original action retained only for pre-trust rows; never a trust claim. */
  readonly sourceAction?: string;
}

export const ADMIN_AUDIT_WRITE_POLICY = Object.freeze({
  MANDATORY_IN_TRANSACTION: 'MANDATORY_IN_TRANSACTION',
  MANDATORY_BEFORE_DISCLOSURE: 'MANDATORY_BEFORE_DISCLOSURE',
  OPTIONAL_TELEMETRY: 'OPTIONAL_TELEMETRY',
} as const);

export type AdminAuditWritePolicy =
  (typeof ADMIN_AUDIT_WRITE_POLICY)[keyof typeof ADMIN_AUDIT_WRITE_POLICY];

export const ADMIN_AUDIT_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const);

export type AdminAuditSeverity = (typeof ADMIN_AUDIT_SEVERITY)[keyof typeof ADMIN_AUDIT_SEVERITY];

export function isAdminAuditSeverity(value: unknown): value is AdminAuditSeverity {
  return Object.values(ADMIN_AUDIT_SEVERITY).some((severity) => severity === value);
}

interface ActiveAdminAuditActionDefinitionV1 {
  readonly lifecycle: 'ACTIVE';
  readonly writePolicy: AdminAuditWritePolicy;
  readonly severity: AdminAuditSeverity;
}

interface RetiredAdminAuditActionDefinitionV1 {
  readonly lifecycle: 'RETIRED_QUERY_ONLY';
  readonly writePolicy: null;
  readonly severity: AdminAuditSeverity;
  readonly successorAuthority: string;
}

export type AdminAuditActionDefinitionV1 =
  | ActiveAdminAuditActionDefinitionV1
  | RetiredAdminAuditActionDefinitionV1;

type ActiveDefinitionFor<TPolicy extends AdminAuditWritePolicy> =
  ActiveAdminAuditActionDefinitionV1 & {
    readonly writePolicy: TPolicy;
  };

const inTransaction = (
  severity: AdminAuditSeverity,
): ActiveDefinitionFor<'MANDATORY_IN_TRANSACTION'> =>
  Object.freeze({
    lifecycle: 'ACTIVE',
    writePolicy: ADMIN_AUDIT_WRITE_POLICY.MANDATORY_IN_TRANSACTION,
    severity,
  });

const beforeDisclosure = (
  severity: AdminAuditSeverity,
): ActiveDefinitionFor<'MANDATORY_BEFORE_DISCLOSURE'> =>
  Object.freeze({
    lifecycle: 'ACTIVE',
    writePolicy: ADMIN_AUDIT_WRITE_POLICY.MANDATORY_BEFORE_DISCLOSURE,
    severity,
  });

const optionalTelemetry = (
  severity: AdminAuditSeverity,
): ActiveDefinitionFor<'OPTIONAL_TELEMETRY'> =>
  Object.freeze({
    lifecycle: 'ACTIVE',
    writePolicy: ADMIN_AUDIT_WRITE_POLICY.OPTIONAL_TELEMETRY,
    severity,
  });

const retired = (
  severity: AdminAuditSeverity,
  successorAuthority: string,
): RetiredAdminAuditActionDefinitionV1 =>
  Object.freeze({
    lifecycle: 'RETIRED_QUERY_ONLY',
    writePolicy: null,
    severity,
    successorAuthority,
  });

/**
 * Exact persisted vocabulary. Retired values remain queryable for historical
 * rows but are excluded from every write method at the type level.
 */
export const ADMIN_AUDIT_ACTION_CATALOG = Object.freeze({
  AUDIT_LOG_ACCESSED: beforeDisclosure(ADMIN_AUDIT_SEVERITY.INFO),
  DATABASE_EXPLORER_READ: beforeDisclosure(ADMIN_AUDIT_SEVERITY.CRITICAL),
  DATABASE_EXPLORER_EXPORT: beforeDisclosure(ADMIN_AUDIT_SEVERITY.CRITICAL),
  DATABASE_EXPLORER_RAW_SQL: beforeDisclosure(ADMIN_AUDIT_SEVERITY.CRITICAL),

  DATABASE_EXPLORER_INSERT: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  DATABASE_EXPLORER_UPDATE: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  DATABASE_EXPLORER_DELETE: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  TENANT_ERASURE_REQUESTED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_PERMISSION_GRANTED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_PERMISSION_REVOKED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_TERMINATED_PERMISSION_REVOKED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_STARTED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_ENDED: inTransaction(ADMIN_AUDIT_SEVERITY.INFO),
  IMPERSONATION_TERMINATED: inTransaction(ADMIN_AUDIT_SEVERITY.CRITICAL),
  IMPERSONATION_EXTENDED: inTransaction(ADMIN_AUDIT_SEVERITY.WARNING),
  IMPERSONATION_EXPIRED: inTransaction(ADMIN_AUDIT_SEVERITY.WARNING),
  IMPERSONATION_OPERATIONS_AUTHORIZED: inTransaction(ADMIN_AUDIT_SEVERITY.INFO),
  IMPERSONATION_OPERATIONS_DENIED: inTransaction(ADMIN_AUDIT_SEVERITY.WARNING),

  ADMIN_OPERATION_TELEMETRY: optionalTelemetry(ADMIN_AUDIT_SEVERITY.INFO),

  LEGACY_TENANT_ACTIVITY_IMPORTED: retired(
    ADMIN_AUDIT_SEVERITY.INFO,
    'auth.tenant_command_receipts',
  ),
  LEGACY_ACTIVITY_IMPORTED: retired(
    ADMIN_AUDIT_SEVERITY.INFO,
    'source-owner typed audit authorities',
  ),
  LEGACY_RETENTION_POLICY_IMPORTED: retired(
    ADMIN_AUDIT_SEVERITY.INFO,
    'data-protection catalog retention authority',
  ),
  TENANT_CREATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  TENANT_CREATE_REQUESTED: retired(
    ADMIN_AUDIT_SEVERITY.INFO,
    'admin.tenant_provisioning_runs+admin.admin_outbox',
  ),
  TENANT_PROVISIONED: retired(
    ADMIN_AUDIT_SEVERITY.INFO,
    'admin.tenant_provisioning_runs+admin.admin_outbox',
  ),
  TENANT_UPDATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  TENANT_SUSPENDED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth.tenant_command_receipts'),
  TENANT_ACTIVATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  TENANT_DEACTIVATED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth.tenant_command_receipts'),
  TENANT_ARCHIVED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth.tenant_command_receipts'),
  TENANT_TIER_CHANGED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'billing command authority'),
  TENANT_LIMITS_UPDATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  MODULES_ASSIGNED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  MODULE_REMOVED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth.tenant_command_receipts'),
  USER_CREATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth audit authority'),
  USER_UPDATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth audit authority'),
  USER_DELETED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  USER_ROLE_CHANGED: retired(ADMIN_AUDIT_SEVERITY.CRITICAL, 'auth audit authority'),
  USER_IMPERSONATED: retired(ADMIN_AUDIT_SEVERITY.CRITICAL, 'admin impersonation ledger'),
  USER_PASSWORD_RESET: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  USER_LOCKED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  USER_UNLOCKED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth audit authority'),
  CONFIG_CREATED: retired(ADMIN_AUDIT_SEVERITY.INFO, 'config-service configuration authority'),
  CONFIG_UPDATED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'config-service configuration authority'),
  CONFIG_DELETED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'config-service configuration authority'),
  SYSTEM_SETTING_CHANGED: retired(
    ADMIN_AUDIT_SEVERITY.WARNING,
    'config-service configuration authority',
  ),
  MAINTENANCE_MODE_ENABLED: retired(
    ADMIN_AUDIT_SEVERITY.CRITICAL,
    'config-service configuration authority',
  ),
  MAINTENANCE_MODE_DISABLED: retired(
    ADMIN_AUDIT_SEVERITY.WARNING,
    'config-service configuration authority',
  ),
  LOGIN_SUCCESS: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth audit authority'),
  LOGIN_FAILED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  LOGOUT: retired(ADMIN_AUDIT_SEVERITY.INFO, 'auth audit authority'),
  TOKEN_REVOKED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  PERMISSION_DENIED: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'auth audit authority'),
  SUSPICIOUS_ACTIVITY: retired(ADMIN_AUDIT_SEVERITY.CRITICAL, 'security event authority'),
  DATA_EXPORT: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'owner-service audit authority'),
  DATA_IMPORT: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'owner-service audit authority'),
  BULK_OPERATION: retired(ADMIN_AUDIT_SEVERITY.WARNING, 'owner-service audit authority'),
} as const satisfies Readonly<Record<string, AdminAuditActionDefinitionV1>>);

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_ACTION_CATALOG;

export type ActiveAdminAuditAction = {
  [TAction in AdminAuditAction]: (typeof ADMIN_AUDIT_ACTION_CATALOG)[TAction]['lifecycle'] extends 'ACTIVE'
    ? TAction
    : never;
}[AdminAuditAction];

export type AdminAuditActionForPolicy<TPolicy extends AdminAuditWritePolicy> = {
  [TAction in ActiveAdminAuditAction]: (typeof ADMIN_AUDIT_ACTION_CATALOG)[TAction]['writePolicy'] extends TPolicy
    ? TAction
    : never;
}[ActiveAdminAuditAction];

export const ADMIN_AUDIT_ACTIONS = Object.freeze(
  Object.keys(ADMIN_AUDIT_ACTION_CATALOG) as AdminAuditAction[],
);

export function isAdminAuditAction(value: unknown): value is AdminAuditAction {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ADMIN_AUDIT_ACTION_CATALOG, value)
  );
}

export function adminAuditDefinition(action: AdminAuditAction): AdminAuditActionDefinitionV1 {
  return ADMIN_AUDIT_ACTION_CATALOG[action];
}

export function adminAuditActionsForPolicy<TPolicy extends AdminAuditWritePolicy>(
  policy: TPolicy,
): readonly AdminAuditActionForPolicy<TPolicy>[] {
  return ADMIN_AUDIT_ACTIONS.filter(
    (action): action is AdminAuditActionForPolicy<TPolicy> =>
      ADMIN_AUDIT_ACTION_CATALOG[action].writePolicy === policy,
  );
}
