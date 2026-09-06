/**
 * Request bodies for `security-monitoring.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { Type, Transform } from 'class-transformer';
import {
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  IsIn,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import {
  SecurityEventType,
  SecurityEventStatus,
  ThreatLevel,
  IncidentStatus,
  IncidentSeverity,
  ThreatIntelligence,
  GeoLocation,
} from '../../entities/security.entity';

export const SECURITY_EVENT_TYPES: readonly SecurityEventType[] = [
  'failed_login',
  'brute_force_attempt',
  'suspicious_activity',
  'unauthorized_access',
  'privilege_escalation',
  'data_exfiltration',
  'malware_detected',
  'api_abuse',
  'rate_limit_exceeded',
  'sql_injection_attempt',
  'xss_attempt',
  'csrf_attempt',
  'account_lockout',
  'password_spray',
  'credential_stuffing',
  'session_hijacking',
  'ip_blacklisted',
  'geo_anomaly',
  'device_anomaly',
  'time_anomaly',
];

export const SECURITY_EVENT_STATUSES: readonly SecurityEventStatus[] = [
  'detected',
  'investigating',
  'confirmed',
  'mitigated',
  'false_positive',
  'escalated',
];

export const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'open',
  'investigating',
  'contained',
  'eradicated',
  'recovered',
  'closed',
];

export const THREAT_INDICATOR_TYPES: ReadonlyArray<ThreatIntelligence['indicatorType']> = [
  'ip',
  'domain',
  'url',
  'hash',
  'email',
  'user_agent',
  'cidr',
];

export class CreateSecurityEventDto {
  /** ADMIN-CRITICAL-009: whitelisted carrier key; the verified id arrives through @TenantParam('body'). */
  @TenantIdCarrier()
  readonly tenantId?: undefined;

  @IsIn(SECURITY_EVENT_TYPES)
  eventType!: SecurityEventType;

  @IsIn(['low', 'medium', 'high', 'critical'])
  threatLevel!: ThreatLevel;

  @IsString()
  title!: string;

  @IsString()
  description!: string;

  @IsString()
  ipAddress!: string;

  @IsOptional()
  geoLocation?: GeoLocation;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  targetResource?: string;

  @IsOptional()
  @IsString()
  targetEndpoint?: string;

  @IsString()
  detectionSource!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  confidenceScore?: number;

  @IsOptional()
  rawData?: Record<string, unknown>;
}

export class QuerySecurityEventsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(SECURITY_EVENT_TYPES)
  eventType?: SecurityEventType;

  @IsOptional()
  @IsString()
  threatLevel?: string; // comma-separated list for multiple levels

  @IsOptional()
  @IsIn(SECURITY_EVENT_STATUSES)
  status?: SecurityEventStatus;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  searchQuery?: string;
}

export class UpdateSecurityEventStatusDto {
  @IsIn(SECURITY_EVENT_STATUSES)
  status!: SecurityEventStatus;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsString()
  assignedToName?: string;

  @IsOptional()
  @IsString()
  investigationNotes?: string;

  @IsOptional()
  @IsString()
  resolution?: string;

  @IsOptional()
  @IsString()
  resolvedBy?: string;
}

export class UpdateIncidentDto {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatus;

  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'critical'])
  severity?: IncidentSeverity;

  @IsOptional()
  @IsString()
  leadInvestigator?: string;

  @IsOptional()
  @IsString()
  leadInvestigatorName?: string;

  @IsOptional()
  @IsString()
  containmentActions?: string;

  @IsOptional()
  @IsString()
  eradicationSteps?: string;

  @IsOptional()
  @IsString()
  recoveryPlan?: string;

  @IsOptional()
  @IsString()
  rootCauseAnalysis?: string;

  @IsOptional()
  @IsString()
  lessonsLearned?: string;

  @IsOptional()
  @IsString()
  impactDescription?: string;
}

export class QueryIncidentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: IncidentStatus;

  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'critical'])
  severity?: IncidentSeverity;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class AddThreatIndicatorDto {
  @IsIn(THREAT_INDICATOR_TYPES)
  indicatorType!: ThreatIntelligence['indicatorType'];

  @IsString()
  value!: string;

  @IsIn(['low', 'medium', 'high', 'critical'])
  threatLevel!: ThreatLevel;

  @IsString()
  source!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  threatTypes?: string[];

  @IsOptional()
  @IsString()
  validUntil?: string;
}

export class QueryThreatIntelligenceDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(THREAT_INDICATOR_TYPES)
  indicatorType?: ThreatIntelligence['indicatorType'];

  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'critical'])
  threatLevel?: ThreatLevel;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  searchQuery?: string;
}
