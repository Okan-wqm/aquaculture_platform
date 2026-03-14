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
  severity: 'low' | 'medium' | 'high' | 'critical';
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
