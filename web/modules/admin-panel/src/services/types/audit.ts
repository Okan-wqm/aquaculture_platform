/**
 * Audit log domain types
 */

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId: string | null;
  performedBy: string;
  performedByEmail: string;
  // Mirrors the backend AuditSeverity enum (apps/admin-api-service/src/audit/
  // audit.entity.ts) — the admin.audit_logs_severity_enum SSoT. Kept in lockstep
  // by tests/invariants/admin-audit-severity-vocab.spec.ts (APA-004 / APA-358).
  severity: 'info' | 'warning' | 'critical';
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface AuditLogStats {
  totalLogs: number;
  last24Hours: number;
  bySeverity: Array<{ severity: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}
