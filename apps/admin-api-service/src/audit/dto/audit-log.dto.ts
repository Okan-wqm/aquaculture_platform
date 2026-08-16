import type { AuditLog } from '../audit.entity';
import type { AuditStatisticsScopeV2 } from '@aquaculture/shared-contracts';
import {
  ADMIN_AUDIT_SEVERITY,
  type AdminAuditAction,
  type AdminAuditLegacyProvenanceV1,
  type AdminAuditSeverity,
  type AdminAuditTrustClass,
} from '@platform/admin-http-contracts';

export const AuditSeverity = ADMIN_AUDIT_SEVERITY;
export type AuditSeverity = AdminAuditSeverity;

export interface AuditLogDto {
  id: string;
  action: AdminAuditAction;
  entityType: string;
  entityId?: string;
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  severity: AuditSeverity;
  trustClass: AdminAuditTrustClass;
  provenance?: AdminAuditLegacyProvenanceV1;
  requestId?: string;
  sessionId?: string;
  createdAt: Date;
  legalHold: boolean;
}

export interface AuditStatisticsDto {
  scope: AuditStatisticsScopeV2;
  totalLogs: number;
  observedLogs: number;
  legacyUnverifiedLogs: number;
  last24Hours: number;
  byAction: Array<{ action: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  byEntityType: Array<{ entityType: string; count: number }>;
  topUsers: Array<{ userId: string; email: string | null; count: number }>;
}

export function toAuditLogDto(log: AuditLog): AuditLogDto {
  return {
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    tenantId: log.tenantId,
    performedBy: log.performedBy,
    performedByEmail: log.performedByEmail,
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    details: log.details,
    previousValue: log.previousValue,
    newValue: log.newValue,
    severity: log.severity,
    trustClass: log.trustClass,
    provenance: log.provenance,
    requestId: log.requestId,
    sessionId: log.sessionId,
    createdAt: log.createdAt,
    legalHold: log.legalHold,
  };
}
