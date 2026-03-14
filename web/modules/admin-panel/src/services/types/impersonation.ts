/**
 * Impersonation domain types
 */

export interface ImpersonationPermission {
  id: string;
  tenantId: string;
  tenantName: string;
  grantedBy: string;
  grantedByEmail: string;
  grantedAt: string;
  expiresAt?: string;
  maxSessionDuration: number;
  allowedActions: string[];
  isActive: boolean;
  reason?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ImpersonationSession {
  id: string;
  adminId: string;
  adminEmail: string;
  tenantId: string;
  tenantName: string;
  originalUserId?: string;
  impersonatedUserId?: string;
  status: 'active' | 'ended' | 'expired' | 'revoked';
  sessionToken: string;
  startedAt: string;
  endedAt?: string;
  expiresAt: string;
  lastActivityAt: string;
  ipAddress: string;
  userAgent?: string;
  actionsPerformed: number;
}

export interface ImpersonationAction {
  id: string;
  sessionId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}
