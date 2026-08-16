import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_LEGACY_PROVENANCE_SCHEMA_VERSION,
  ADMIN_AUDIT_LEGACY_SOURCES,
  ADMIN_AUDIT_TRUST_CLASSES,
  adminManualResponse,
  adminResponse,
  type AdminResponseProjection,
} from '@platform/admin-http-contracts';

export const auditLogExportProfile = adminManualResponse.binary([200], ['text/csv'], 33_554_432);

export const auditLogAuditLogDtoContract = adminResponse.object({
  id: adminResponse.string(),
  action: adminResponse.literalSet(ADMIN_AUDIT_ACTIONS),
  entityType: adminResponse.string(),
  entityId: adminResponse.optional(adminResponse.string()),
  tenantId: adminResponse.optional(adminResponse.string()),
  performedBy: adminResponse.string(),
  performedByEmail: adminResponse.optional(adminResponse.string()),
  ipAddress: adminResponse.optional(adminResponse.string()),
  userAgent: adminResponse.optional(adminResponse.string()),
  details: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
  previousValue: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
  newValue: adminResponse.optional(
    adminResponse.record(adminResponse.json('security-audit-context')),
  ),
  severity: adminResponse.union([
    adminResponse.literal('info'),
    adminResponse.literal('warning'),
    adminResponse.literal('critical'),
  ] as const),
  trustClass: adminResponse.literalSet(ADMIN_AUDIT_TRUST_CLASSES),
  provenance: adminResponse.optional(
    adminResponse.object({
      schemaVersion: adminResponse.literal(ADMIN_AUDIT_LEGACY_PROVENANCE_SCHEMA_VERSION),
      sourceAuthority: adminResponse.literalSet(ADMIN_AUDIT_LEGACY_SOURCES),
      sourceRowId: adminResponse.string(),
      sourceRowSha256: adminResponse.string(),
      sourceAction: adminResponse.optional(adminResponse.string()),
    }),
  ),
  requestId: adminResponse.optional(adminResponse.string()),
  sessionId: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  legalHold: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type AuditLogAuditLogDtoDto = AdminResponseProjection<typeof auditLogAuditLogDtoContract>;

export const auditStatisticsScopeContract = adminResponse.object({
  schemaVersion: adminResponse.literal('audit-statistics-scope.v2'),
  source: adminResponse.literal('admin.audit_logs'),
  qualification: adminResponse.literal('AUTHORITATIVE_RUNTIME_ONLY'),
  tenantId: adminResponse.nullable(adminResponse.string()),
  startDate: adminResponse.nullable(adminResponse.dateString()),
  endDate: adminResponse.dateString(),
  asOf: adminResponse.dateString(),
  scopeSha256: adminResponse.string(),
});

export const auditLogAuditStatisticsDtoContract = adminResponse.object({
  scope: auditStatisticsScopeContract,
  totalLogs: adminResponse.number(),
  observedLogs: adminResponse.number(),
  legacyUnverifiedLogs: adminResponse.number(),
  last24Hours: adminResponse.number(),
  byAction: adminResponse.array(
    adminResponse.object({
      action: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  bySeverity: adminResponse.array(
    adminResponse.object({
      severity: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  byEntityType: adminResponse.array(
    adminResponse.object({
      entityType: adminResponse.string(),
      count: adminResponse.number(),
    }),
  ),
  topUsers: adminResponse.array(
    adminResponse.object({
      userId: adminResponse.string(),
      email: adminResponse.nullable(adminResponse.string()),
      count: adminResponse.number(),
    }),
  ),
});

export type AuditLogAuditStatisticsDtoDto = AdminResponseProjection<
  typeof auditLogAuditStatisticsDtoContract
>;

export const auditLogAuditLogDtoPageContract = adminResponse.page(auditLogAuditLogDtoContract);

export const auditLogAuditLogDtoArrayContract = adminResponse.array(auditLogAuditLogDtoContract);
