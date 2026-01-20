/**
 * Security & Audit Entities
 *
 * Activity logging, security events, compliance tracking,
 * threat intelligence ve audit trail entities.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

// ============================================================================
// Enums & Types
// ============================================================================

export type ActivityCategory =
  | 'user_action'
  | 'system_event'
  | 'api_call'
  | 'data_access'
  | 'security_event'
  | 'configuration'
  | 'authentication';

export type ActivitySeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export type SecurityEventType =
  | 'failed_login'
  | 'brute_force_attempt'
  | 'suspicious_activity'
  | 'unauthorized_access'
  | 'privilege_escalation'
  | 'data_exfiltration'
  | 'malware_detected'
  | 'api_abuse'
  | 'rate_limit_exceeded'
  | 'sql_injection_attempt'
  | 'xss_attempt'
  | 'csrf_attempt'
  | 'account_lockout'
  | 'password_spray'
  | 'credential_stuffing'
  | 'session_hijacking'
  | 'ip_blacklisted'
  | 'geo_anomaly'
  | 'device_anomaly'
  | 'time_anomaly';

export type SecurityEventStatus = 'detected' | 'investigating' | 'confirmed' | 'mitigated' | 'false_positive' | 'escalated';

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export type ComplianceType = 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'sox' | 'iso27001';

export type DataRequestType = 'access' | 'deletion' | 'portability' | 'rectification' | 'restriction';

export type DataRequestStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'expired';

export type IncidentStatus = 'open' | 'investigating' | 'contained' | 'eradicated' | 'recovered' | 'closed';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

// ============================================================================
// Interfaces
// ============================================================================

export interface GeoLocation {
  country: string;
  countryCode: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface DeviceInfo {
  userAgent: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  device: string;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
  isMobile: boolean;
  isBot: boolean;
}

export interface RequestInfo {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  responseStatus?: number;
  responseTime?: number;
  responseSize?: number;
}

export interface AnomalyDetails {
  type: string;
  score: number;
  threshold: number;
  baseline: Record<string, unknown>;
  current: Record<string, unknown>;
  factors: string[];
}

export interface ThreatIndicator {
  type: 'ip' | 'domain' | 'url' | 'hash' | 'email' | 'user_agent';
  value: string;
  source: string;
  confidence: number;
  lastSeen: Date;
  tags: string[];
}

export interface ComplianceViolation {
  requirement: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  remediation: string;
  deadline?: Date;
}

export interface RetentionPolicy {
  category: ActivityCategory;
  retentionDays: number;
  archiveAfterDays?: number;
  deleteAfterArchiveDays?: number;
}

// ============================================================================
// Activity Log Entity
// ============================================================================

@Entity('activity_logs', { schema: 'public' })
@Index(['tenantId', 'createdAt'])
@Index(['userId', 'createdAt'])
@Index(['category', 'createdAt'])
@Index(['severity', 'createdAt'])
@Index(['ipAddress', 'createdAt'])
@Index(['action', 'createdAt'])
@Index(['entityType'])
@Index(['entityId'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userEmail: string | null;

  @Column({ type: 'varchar', length: 50 })
  category: ActivityCategory;

  @Column({ type: 'varchar', length: 20, default: 'info' })
  severity: ActivitySeverity;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'text' })
  description: string;

  // Entity affected by this action
  @Column({ type: 'varchar', length: 100, nullable: true })
  entityType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  entityId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  entityName: string | null;

  // Request details
  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ type: 'jsonb', nullable: true })
  geoLocation: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true })
  deviceInfo: DeviceInfo | null;

  @Column({ type: 'jsonb', nullable: true })
  requestInfo: RequestInfo | null;

  // Session info
  @Column({ type: 'varchar', length: 255, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  correlationId: string | null;

  // Change tracking
  @Column({ type: 'jsonb', nullable: true })
  previousValue: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  newValue: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  changedFields: string[] | null;

  // Additional metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  // Tags for categorization
  @Column({ type: 'simple-array', nullable: true })
  tags: string[] | null;

  // Outcome
  @Column({ type: 'boolean', default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  errorCode: string | null;

  // Duration in milliseconds
  @Column({ type: 'int', nullable: true })
  duration: number | null;

  @CreateDateColumn()
  createdAt: Date;

  // For archival tracking
  @Column({ type: 'boolean', default: false })
  isArchived: boolean;

  @Column({ type: 'timestamp', nullable: true })
  archivedAt: Date | null;
}

// ============================================================================
// Security Event Entity
// ============================================================================

@Entity('security_events', { schema: 'public' })
@Index(['tenantId', 'createdAt'])
@Index(['eventType', 'createdAt'])
@Index(['status', 'createdAt'])
@Index(['threatLevel', 'createdAt'])
@Index(['ipAddress', 'createdAt'])
@Index(['userId'])
export class SecurityEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  eventType: SecurityEventType;

  @Column({ type: 'varchar', length: 20 })
  threatLevel: ThreatLevel;

  @Column({ type: 'varchar', length: 20, default: 'detected' })
  status: SecurityEventStatus;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  // Source info
  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ type: 'jsonb', nullable: true })
  geoLocation: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true })
  deviceInfo: DeviceInfo | null;

  // Target info
  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userName: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  targetResource: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  targetEndpoint: string | null;

  // Detection details
  @Column({ type: 'varchar', length: 100 })
  detectionSource: string;

  @Column({ type: 'float', nullable: true })
  confidenceScore: number | null;

  @Column({ type: 'jsonb', nullable: true })
  anomalyDetails: AnomalyDetails | null;

  @Column({ type: 'jsonb', nullable: true })
  indicators: ThreatIndicator[] | null;

  // Evidence
  @Column({ type: 'jsonb', nullable: true })
  rawData: Record<string, unknown> | null;

  @Column({ type: 'simple-array', nullable: true })
  relatedActivityIds: string[] | null;

  // Response
  @Column({ type: 'boolean', default: false })
  autoMitigated: boolean;

  @Column({ type: 'simple-array', nullable: true })
  mitigationActions: string[] | null;

  @Column({ type: 'text', nullable: true })
  investigationNotes: string | null;

  // Assignment
  @Column({ type: 'varchar', length: 100, nullable: true })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  assignedToName: string | null;

  @Column({ type: 'timestamp', nullable: true })
  assignedAt: Date | null;

  // Resolution
  @Column({ type: 'text', nullable: true })
  resolution: string | null;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  resolvedBy: string | null;

  // Metadata
  @Column({ type: 'simple-array', nullable: true })
  tags: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Security Incident Entity
// ============================================================================

@Entity('security_incidents', { schema: 'public' })
@Index(['status', 'createdAt'])
@Index(['severity', 'createdAt'])
export class SecurityIncident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  incidentNumber: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 20 })
  severity: IncidentSeverity;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status: IncidentStatus;

  // Classification
  @Column({ type: 'varchar', length: 100 })
  category: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  attackVector: string | null;

  @Column({ type: 'simple-array', nullable: true })
  affectedSystems: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  affectedTenants: string[] | null;

  // Impact assessment
  @Column({ type: 'boolean', default: false })
  dataBreached: boolean;

  @Column({ type: 'int', default: 0 })
  affectedUsersCount: number;

  @Column({ type: 'text', nullable: true })
  impactDescription: string | null;

  @Column({ type: 'text', nullable: true })
  businessImpact: string | null;

  // Timeline
  @Column({ type: 'timestamp', nullable: true })
  detectedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  containedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  eradicatedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  recoveredAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  closedAt: Date | null;

  // Response team
  @Column({ type: 'varchar', length: 100, nullable: true })
  leadInvestigator: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  leadInvestigatorName: string | null;

  @Column({ type: 'simple-array', nullable: true })
  teamMembers: string[] | null;

  // Related events
  @Column({ type: 'simple-array', nullable: true })
  relatedSecurityEvents: string[] | null;

  // Documentation
  @Column({ type: 'text', nullable: true })
  rootCauseAnalysis: string | null;

  @Column({ type: 'text', nullable: true })
  lessonsLearned: string | null;

  @Column({ type: 'jsonb', nullable: true })
  remediationSteps: { step: string; completed: boolean; completedAt?: Date }[] | null;

  // External reporting
  @Column({ type: 'boolean', default: false })
  reportedToAuthorities: boolean;

  @Column({ type: 'timestamp', nullable: true })
  reportedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reportReference: string | null;

  // Audit trail
  @Column({ type: 'jsonb', nullable: true })
  timeline: { timestamp: Date; action: string; actor: string; details?: string }[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 100 })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Threat Intelligence Entity
// ============================================================================

@Entity('threat_intelligence', { schema: 'public' })
@Index(['indicatorType'])
@Index(['value'])
@Index(['threatLevel'])
@Index(['isActive'])
export class ThreatIntelligence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  indicatorType: 'ip' | 'domain' | 'url' | 'hash' | 'email' | 'user_agent' | 'cidr';

  @Column({ type: 'varchar', length: 500 })
  value: string;

  @Column({ type: 'varchar', length: 20 })
  threatLevel: ThreatLevel;

  @Column({ type: 'varchar', length: 100 })
  source: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  // Classification
  @Column({ type: 'simple-array', nullable: true })
  threatTypes: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  tags: string[] | null;

  // Confidence & validity
  @Column({ type: 'float', default: 0.5 })
  confidence: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true })
  validFrom: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  validUntil: Date | null;

  // Activity tracking
  @Column({ type: 'int', default: 0 })
  hitCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  firstSeenAt: Date | null;

  // Related data
  @Column({ type: 'simple-array', nullable: true })
  relatedIndicators: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  geoData: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Data Request Entity (GDPR, CCPA compliance)
// ============================================================================

@Entity('data_requests', { schema: 'public' })
@Index(['tenantId', 'createdAt'])
@Index(['requestType', 'status'])
@Index(['dueDate'])
export class DataRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  requestNumber: string;

  @Column({ type: 'varchar', length: 50 })
  requestType: DataRequestType;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: DataRequestStatus;

  @Column({ type: 'varchar', length: 20 })
  complianceFramework: ComplianceType;

  // Requester info
  @Column({ type: 'varchar', length: 100 })
  tenantId: string;

  @Column({ type: 'varchar', length: 255 })
  tenantName: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requesterId: string | null;

  @Column({ type: 'varchar', length: 255 })
  requesterName: string;

  @Column({ type: 'varchar', length: 255 })
  requesterEmail: string;

  // Request details
  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'simple-array', nullable: true })
  dataCategories: string[] | null;

  @Column({ type: 'text', nullable: true })
  specificData: string | null;

  // Identity verification
  @Column({ type: 'boolean', default: false })
  identityVerified: boolean;

  @Column({ type: 'timestamp', nullable: true })
  verifiedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  verifiedBy: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  verificationMethod: string | null;

  // Processing
  @Column({ type: 'timestamp' })
  dueDate: Date;

  @Column({ type: 'varchar', length: 100, nullable: true })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  assignedToName: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processingStartedAt: Date | null;

  // Completion
  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  completedBy: string | null;

  @Column({ type: 'text', nullable: true })
  completionNotes: string | null;

  // Delivery (for access/portability requests)
  @Column({ type: 'varchar', length: 20, nullable: true })
  deliveryFormat: 'json' | 'csv' | 'pdf' | 'xml' | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  downloadUrl: string | null;

  @Column({ type: 'timestamp', nullable: true })
  downloadExpiresAt: Date | null;

  @Column({ type: 'int', default: 0 })
  downloadCount: number;

  // Rejection (if applicable)
  @Column({ type: 'text', nullable: true })
  rejectionReason: string | null;

  // Audit trail
  @Column({ type: 'jsonb', nullable: true })
  auditTrail: { timestamp: Date; action: string; actor: string; details?: string }[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Compliance Report Entity
// ============================================================================

@Entity('compliance_reports', { schema: 'public' })
@Index(['complianceType', 'createdAt'])
@Index(['reportPeriodStart', 'reportPeriodEnd'])
export class ComplianceReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 20 })
  complianceType: ComplianceType;

  @Column({ type: 'timestamp' })
  reportPeriodStart: Date;

  @Column({ type: 'timestamp' })
  reportPeriodEnd: Date;

  // Scope
  @Column({ type: 'simple-array', nullable: true })
  includedTenants: string[] | null;

  @Column({ type: 'boolean', default: true })
  includesAllTenants: boolean;

  // Summary metrics
  @Column({ type: 'int', default: 0 })
  totalDataRequests: number;

  @Column({ type: 'int', default: 0 })
  completedDataRequests: number;

  @Column({ type: 'int', default: 0 })
  pendingDataRequests: number;

  @Column({ type: 'float', nullable: true })
  avgResponseTimeDays: number | null;

  @Column({ type: 'int', default: 0 })
  securityIncidents: number;

  @Column({ type: 'int', default: 0 })
  dataBreaches: number;

  // Compliance status
  @Column({ type: 'float', default: 100 })
  complianceScore: number;

  @Column({ type: 'jsonb', nullable: true })
  violations: ComplianceViolation[] | null;

  @Column({ type: 'jsonb', nullable: true })
  recommendations: string[] | null;

  // Report content
  @Column({ type: 'text', nullable: true })
  executiveSummary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detailedFindings: Record<string, unknown> | null;

  // Generated files
  @Column({ type: 'varchar', length: 500, nullable: true })
  pdfUrl: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  csvUrl: string | null;

  // Generation info
  @Column({ type: 'varchar', length: 100 })
  generatedBy: string;

  @Column({ type: 'varchar', length: 255 })
  generatedByName: string;

  @Column({ type: 'boolean', default: false })
  isAutoGenerated: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Retention Policy Entity
// ============================================================================

@Entity('retention_policies', { schema: 'public' })
@Index(['name'], { unique: true })
export class RetentionPolicyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  name: string;

  @Column({ type: 'varchar', length: 50 })
  category: ActivityCategory;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  // Retention settings
  @Column({ type: 'int' })
  retentionDays: number;

  @Column({ type: 'int', nullable: true })
  archiveAfterDays: number | null;

  @Column({ type: 'int', nullable: true })
  deleteAfterArchiveDays: number | null;

  // Scope
  @Column({ type: 'boolean', default: true })
  isGlobal: boolean;

  @Column({ type: 'simple-array', nullable: true })
  specificTenants: string[] | null;

  // Compliance requirements
  @Column({ type: 'simple-array', nullable: true })
  complianceFrameworks: ComplianceType[] | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  // Audit
  @Column({ type: 'varchar', length: 100 })
  createdBy: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  updatedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ============================================================================
// Login Attempt Entity (for brute force detection)
// ============================================================================

@Entity('login_attempts', { schema: 'public' })
@Index(['ipAddress', 'createdAt'])
@Index(['email', 'createdAt'])
@Index(['success', 'createdAt'])
export class LoginAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ type: 'boolean' })
  success: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  failureReason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  geoLocation: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true })
  deviceInfo: DeviceInfo | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sessionId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

// ============================================================================
// API Usage Log Entity
// ============================================================================

@Entity('api_usage_logs', { schema: 'public' })
@Index(['tenantId', 'createdAt'])
@Index(['endpoint', 'createdAt'])
@Index(['statusCode', 'createdAt'])
@Index(['userId'])
@Index(['ipAddress'])
export class ApiUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  apiKeyId: string | null;

  // Request details
  @Column({ type: 'varchar', length: 10 })
  method: string;

  @Column({ type: 'varchar', length: 500 })
  endpoint: string;

  @Column({ type: 'varchar', length: 500 })
  path: string;

  @Column({ type: 'jsonb', nullable: true })
  queryParams: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  requestSize: number | null;

  // Response details
  @Column({ type: 'int' })
  statusCode: number;

  @Column({ type: 'int', nullable: true })
  responseSize: number | null;

  @Column({ type: 'int' })
  responseTimeMs: number;

  // Source
  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'jsonb', nullable: true })
  geoLocation: GeoLocation | null;

  // Rate limiting
  @Column({ type: 'int', nullable: true })
  rateLimitRemaining: number | null;

  @Column({ type: 'boolean', default: false })
  rateLimitExceeded: boolean;

  // Error details
  @Column({ type: 'boolean', default: false })
  isError: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  correlationId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

// ============================================================================
// Session Entity (for session tracking)
// ============================================================================

@Entity('user_sessions', { schema: 'public' })
@Index(['userId', 'isActive'])
@Index(['tenantId', 'isActive'])
@Index(['sessionToken'], { unique: true })
@Index(['lastActivityAt'])
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  sessionToken: string;

  @Column({ type: 'varchar', length: 100 })
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  userName: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tenantName: string | null;

  // Session info
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  // Source info
  @Column({ type: 'varchar', length: 45 })
  ipAddress: string;

  @Column({ type: 'jsonb', nullable: true })
  geoLocation: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true })
  deviceInfo: DeviceInfo | null;

  // Activity tracking
  @Column({ type: 'int', default: 0 })
  requestCount: number;

  @Column({ type: 'timestamp' })
  lastActivityAt: Date;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastActivityPath: string | null;

  // Termination
  @Column({ type: 'timestamp', nullable: true })
  terminatedAt: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  terminationReason: 'logout' | 'expired' | 'forced' | 'security' | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  terminatedBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
