/**
 * Persistence-independent security vocabulary.
 *
 * This module owns the value types shared by HTTP projections, application
 * services, and persistence mappings. TypeORM entities consume this vocabulary;
 * they never define a wire contract.
 */

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

export type SecurityEventStatus =
  | 'detected'
  | 'investigating'
  | 'confirmed'
  | 'mitigated'
  | 'false_positive'
  | 'escalated';

export type ThreatLevel = 'low' | 'medium' | 'high' | 'critical';

export type ComplianceType =
  | 'gdpr'
  | 'ccpa'
  | 'hipaa'
  | 'pci_dss'
  | 'sox'
  | 'iso27001';

export type DataRequestType =
  | 'access'
  | 'deletion'
  | 'portability'
  | 'rectification'
  | 'restriction';

export type DataRequestStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'expired';

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'contained'
  | 'eradicated'
  | 'recovered'
  | 'closed';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ThreatIndicatorType =
  | 'ip'
  | 'domain'
  | 'url'
  | 'hash'
  | 'email'
  | 'user_agent'
  | 'cidr';

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
  type: Exclude<ThreatIndicatorType, 'cidr'>;
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
