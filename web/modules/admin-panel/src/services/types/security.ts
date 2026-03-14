/**
 * Security domain types
 */

export type SecurityEventSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SecurityEventType = 'login_failure' | 'suspicious_activity' | 'permission_violation' | 'data_breach' | 'api_abuse' | 'brute_force';

export interface ActivityLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId?: string;
  userId: string;
  userEmail: string;
  ipAddress: string;
  userAgent: string;
  location?: { country: string; city: string };
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface AuditTrailEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy: string;
  performedByEmail: string;
  reason?: string;
  timestamp: string;
}

export interface RetentionPolicy {
  id: string;
  name: string;
  entityType: string;
  retentionDays: number;
  archiveAfterDays?: number;
  isActive: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface ComplianceReport {
  id: string;
  type: 'gdpr' | 'hipaa' | 'soc2' | 'iso27001' | 'custom';
  status: 'compliant' | 'non_compliant' | 'partial' | 'pending_review';
  findings: Array<{ area: string; status: string; details: string }>;
  score: number;
  generatedAt: string;
  validUntil: string;
}

export interface DataSubjectRequest {
  id: string;
  type: 'access' | 'rectification' | 'erasure' | 'portability' | 'restriction';
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  subjectEmail: string;
  subjectName?: string;
  tenantId?: string;
  requestedAt: string;
  dueDate: string;
  completedAt?: string;
  handledBy?: string;
  notes?: string;
}

export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  title: string;
  description: string;
  sourceIp?: string;
  userId?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  isResolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}

export interface SecurityIncident {
  id: string;
  title: string;
  description: string;
  severity: SecurityEventSeverity;
  status: 'open' | 'investigating' | 'contained' | 'resolved' | 'closed';
  affectedTenants: string[];
  affectedUsers: number;
  rootCause?: string;
  resolution?: string;
  timeline: Array<{ action: string; timestamp: string; performedBy: string }>;
  assignedTo?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ThreatIndicator {
  id: string;
  type: 'ip' | 'domain' | 'email' | 'hash';
  value: string;
  threatLevel: SecurityEventSeverity;
  description?: string;
  source: string;
  lastSeenAt: string;
  isBlocked: boolean;
  createdAt: string;
}
