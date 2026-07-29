/**
 * Security Monitoring Controller
 *
 * Endpoints for security events, incidents, threat intelligence, and dashboard.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Query,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Type, Transform } from 'class-transformer';
import { IsOptional, IsNumber, IsString, IsBoolean, IsIn, IsArray, Min, Max } from 'class-validator';

import { getAuthUser } from '../../shared/authenticated-request';

import {
  SecurityEvent,
  SecurityEventType,
  SecurityEventStatus,
  ThreatLevel,
  SecurityIncident,
  IncidentStatus,
  IncidentSeverity,
  ThreatIntelligence,
  GeoLocation,
} from '../entities/security.entity';
import {
  AnomalyDetectionConfig,
  SecurityMonitoringService,
  SecurityDashboardStats,
  SecurityEventStats,
  IncidentStats,
  ThreatIntelStats,
  ThreatCheckResult,
  LoginAnalysisAcknowledgement,
  SecurityHealthScore,
  SecurityHealthFactor,
} from '../services/security-monitoring.service';
import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

// ============================================================================
// DTOs
// ============================================================================

const SECURITY_EVENT_TYPES: readonly SecurityEventType[] = [
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

const SECURITY_EVENT_STATUSES: readonly SecurityEventStatus[] = [
  'detected',
  'investigating',
  'confirmed',
  'mitigated',
  'false_positive',
  'escalated',
];

const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'open',
  'investigating',
  'contained',
  'eradicated',
  'recovered',
  'closed',
];

const THREAT_INDICATOR_TYPES: ReadonlyArray<ThreatIntelligence['indicatorType']> = [
  'ip',
  'domain',
  'url',
  'hash',
  'email',
  'user_agent',
  'cidr',
];

class CreateSecurityEventDto {
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
  tenantId?: string;

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

class QuerySecurityEventsDto {
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

class UpdateSecurityEventStatusDto {
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

class UpdateIncidentDto {
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

class QueryIncidentsDto {
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

class AddThreatIndicatorDto {
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

class QueryThreatIntelligenceDto {
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

class AnalyzeLoginDto {
  @IsString()
  email!: string;

  @IsString()
  ipAddress!: string;

  @IsBoolean()
  success!: boolean;

  @IsOptional()
  geoLocation?: GeoLocation;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Security')
@Controller('security/monitoring')
export class SecurityMonitoringController {
  constructor(
    private readonly securityMonitoringService: SecurityMonitoringService,
  ) {}

  // ============================================================================
  // Security Events
  // ============================================================================

  /**
   * Create security event
   */
  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  async createSecurityEvent(
    @Body() dto: CreateSecurityEventDto,
  ): Promise<SecurityEvent> {
    return this.securityMonitoringService.createSecurityEvent({
      eventType: dto.eventType,
      threatLevel: dto.threatLevel,
      title: dto.title,
      description: dto.description,
      ipAddress: dto.ipAddress,
      geoLocation: dto.geoLocation,
      tenantId: dto.tenantId,
      userId: dto.userId,
      userName: dto.userName,
      targetResource: dto.targetResource,
      targetEndpoint: dto.targetEndpoint,
      detectionSource: dto.detectionSource,
      confidenceScore: dto.confidenceScore,
      rawData: dto.rawData,
    });
  }

  /**
   * Get security event by ID
   */
  @Get('events/:id')
  async getSecurityEvent(@Param('id') id: string): Promise<SecurityEvent> {
    return this.securityMonitoringService.getSecurityEvent(id);
  }

  /**
   * Query security events
   */
  @Get('events')
  async querySecurityEvents(
    @Query() query: QuerySecurityEventsDto,
  ): Promise<IStandardPaginatedResult<SecurityEvent>> {
    // Parse threat levels from comma-separated string
    const threatLevel = query.threatLevel
      ? (query.threatLevel.split(',') as ThreatLevel[])
      : undefined;

    return this.securityMonitoringService.querySecurityEvents({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      eventType: query.eventType,
      threatLevel,
      status: query.status,
      ipAddress: query.ipAddress,
      tenantId: query.tenantId,
      userId: query.userId,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      searchQuery: query.searchQuery,
    });
  }

  /**
   * Update security event status
   */
  @Put('events/:id/status')
  async updateSecurityEventStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSecurityEventStatusDto,
  ): Promise<SecurityEvent> {
    return this.securityMonitoringService.updateSecurityEventStatus(
      id,
      dto.status,
      {
        assignedTo: dto.assignedTo,
        assignedToName: dto.assignedToName,
        investigationNotes: dto.investigationNotes,
        resolution: dto.resolution,
        resolvedBy: dto.resolvedBy,
      },
    );
  }

  /**
   * Get security event statistics
   */
  @Get('events/stats/summary')
  async getSecurityEventStats(): Promise<SecurityEventStats> {
    const result = await this.securityMonitoringService.querySecurityEvents({
      page: 1,
      limit: 10000,
    });

    const stats: SecurityEventStats = {
      total: result.total,
      byThreatLevel: {},
      byEventType: {},
      byStatus: {},
    };

    for (const event of result.items) {
      stats.byThreatLevel[event.threatLevel] =
        (stats.byThreatLevel[event.threatLevel] || 0) + 1;
      stats.byEventType[event.eventType] =
        (stats.byEventType[event.eventType] || 0) + 1;
      stats.byStatus[event.status] =
        (stats.byStatus[event.status] || 0) + 1;
    }

    return stats;
  }

  // ============================================================================
  // Security Incidents
  // ============================================================================

  /**
   * Get incident by ID
   */
  @Get('incidents/:id')
  async getIncident(@Param('id') id: string): Promise<SecurityIncident> {
    return this.securityMonitoringService.getIncident(id);
  }

  /**
   * Query incidents
   */
  @Get('incidents')
  async queryIncidents(
    @Query() query: QueryIncidentsDto,
  ): Promise<IStandardPaginatedResult<SecurityIncident>> {
    return this.securityMonitoringService.queryIncidents({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      status: query.status,
      severity: query.severity,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
  }

  /**
   * Update incident
   */
  @Put('incidents/:id')
  async updateIncident(
    @Param('id') id: string,
    @Body() dto: UpdateIncidentDto,
    @Req() req: Request,
  ): Promise<SecurityIncident> {
    const user = getAuthUser(req);
    if (!user?.id) throw new UnauthorizedException('User not authenticated');
    return this.securityMonitoringService.updateIncident(
      id,
      dto,
      user.id,
      user.name || user.email || user.id,
    );
  }

  /**
   * Get incident statistics
   */
  @Get('incidents/stats/summary')
  async getIncidentStats(): Promise<IncidentStats> {
    const result = await this.securityMonitoringService.queryIncidents({
      page: 1,
      limit: 10000,
    });

    const stats: IncidentStats = {
      total: result.total,
      byStatus: {},
      bySeverity: {},
    };

    for (const incident of result.items) {
      stats.byStatus[incident.status] =
        (stats.byStatus[incident.status] || 0) + 1;
      stats.bySeverity[incident.severity] =
        (stats.bySeverity[incident.severity] || 0) + 1;
    }

    return stats;
  }

  // ============================================================================
  // Threat Intelligence
  // ============================================================================

  /**
   * Add threat indicator
   */
  @Post('threat-intelligence')
  @HttpCode(HttpStatus.CREATED)
  async addThreatIndicator(
    @Body() dto: AddThreatIndicatorDto,
  ): Promise<ThreatIntelligence> {
    return this.securityMonitoringService.addThreatIndicator({
      indicatorType: dto.indicatorType,
      value: dto.value,
      threatLevel: dto.threatLevel,
      source: dto.source,
      description: dto.description,
      threatTypes: dto.threatTypes,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
    });
  }

  /**
   * Query threat intelligence
   */
  @Get('threat-intelligence')
  async queryThreatIntelligence(
    @Query() query: QueryThreatIntelligenceDto,
  ): Promise<IStandardPaginatedResult<ThreatIntelligence>> {
    return this.securityMonitoringService.queryThreatIntelligence({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      indicatorType: query.indicatorType,
      threatLevel: query.threatLevel,
      isActive: query.isActive,
      searchQuery: query.searchQuery,
    });
  }

  /**
   * Check if IP is a known threat
   */
  @Get('threat-intelligence/check/:ip')
  async checkThreat(
    @Param('ip') ip: string,
  ): Promise<ThreatCheckResult> {
    const threat = await this.securityMonitoringService.checkThreatIntelligence(ip);
    return {
      isThreat: threat !== null,
      threat,
    };
  }

  /**
   * Get threat intelligence statistics
   */
  @Get('threat-intelligence/stats')
  async getThreatIntelStats(): Promise<ThreatIntelStats> {
    const result = await this.securityMonitoringService.queryThreatIntelligence({
      page: 1,
      limit: 10000,
      isActive: true,
    });

    const stats: ThreatIntelStats = {
      total: result.total,
      byIndicatorType: {},
      byThreatLevel: {},
    };

    for (const indicator of result.items) {
      stats.byIndicatorType[indicator.indicatorType] =
        (stats.byIndicatorType[indicator.indicatorType] || 0) + 1;
      stats.byThreatLevel[indicator.threatLevel] =
        (stats.byThreatLevel[indicator.threatLevel] || 0) + 1;
    }

    return stats;
  }

  // ============================================================================
  // Analysis & Detection
  // ============================================================================

  /**
   * Analyze login attempt for anomalies
   */
  @Post('analyze/login')
  @HttpCode(HttpStatus.OK)
  async analyzeLogin(
    @Body() dto: AnalyzeLoginDto,
  ): Promise<LoginAnalysisAcknowledgement> {
    await this.securityMonitoringService.analyzeLoginAttempt({
      email: dto.email,
      ipAddress: dto.ipAddress,
      success: dto.success,
      geoLocation: dto.geoLocation,
      userId: dto.userId,
      tenantId: dto.tenantId,
    });

    return {
      analyzed: true,
      message: 'Login attempt analyzed for anomalies',
    };
  }

  /**
   * Get anomaly detection configuration
   */
  @Get('config/anomaly-detection')
  getAnomalyConfig(): AnomalyDetectionConfig {
    return this.securityMonitoringService.getAnomalyConfig();
  }

  // ============================================================================
  // Dashboard
  // ============================================================================

  /**
   * Get security dashboard statistics
   */
  @Get('dashboard')
  async getDashboardStats(): Promise<SecurityDashboardStats> {
    return this.securityMonitoringService.getSecurityDashboardStats();
  }

  /**
   * Get real-time security alerts (unresolved events)
   */
  @Get('alerts/realtime')
  async getRealtimeAlerts(
    @Query('limit') limit?: number,
  ): Promise<SecurityEvent[]> {
    const result = await this.securityMonitoringService.querySecurityEvents({
      page: 1,
      limit: limit ? parseInt(String(limit), 10) : 10,
      status: 'detected',
    });

    // Sort by threat level (critical first) and date
    return result.items.sort((a, b) => {
      const threatOrder: Record<ThreatLevel, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      const levelDiff = (threatOrder[a.threatLevel] ?? 4) - (threatOrder[b.threatLevel] ?? 4);
      if (levelDiff !== 0) return levelDiff;
      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });
  }

  /**
   * Get security health score
   */
  @Get('health-score')
  async getHealthScore(): Promise<SecurityHealthScore> {
    const [dashboard, liveness] = await Promise.all([
      this.securityMonitoringService.getSecurityDashboardStats(),
      this.securityMonitoringService.getTelemetryLiveness(),
    ]);

    const factors: SecurityHealthFactor[] = [];
    const recommendations: string[] = [];

    // Factor 1: Active incidents (weight: 30%)
    const activeIncidents = dashboard.activeIncidents;
    let incidentScore = 100;
    if (activeIncidents > 10) incidentScore = 20;
    else if (activeIncidents > 5) incidentScore = 50;
    else if (activeIncidents > 2) incidentScore = 70;
    else if (activeIncidents > 0) incidentScore = 85;

    factors.push({
      name: 'Active Incidents',
      score: incidentScore,
      weight: 30,
      description: `${activeIncidents} active incidents`,
    });

    if (incidentScore < 70) {
      recommendations.push('Prioritize resolving active security incidents');
    }

    // Factor 2: Critical events (weight: 25%)
    const criticalEvents = dashboard.criticalEvents;
    let criticalScore = 100;
    if (criticalEvents > 10) criticalScore = 20;
    else if (criticalEvents > 5) criticalScore = 50;
    else if (criticalEvents > 2) criticalScore = 70;
    else if (criticalEvents > 0) criticalScore = 85;

    factors.push({
      name: 'Critical Events',
      score: criticalScore,
      weight: 25,
      description: `${criticalEvents} critical events`,
    });

    if (criticalScore < 70) {
      recommendations.push('Investigate and mitigate critical security events');
    }

    // Factor 3: Event trend (weight: 25%)
    let trendScore = 100;
    if (dashboard.eventsTrend === 'increasing') trendScore = 50;
    else if (dashboard.eventsTrend === 'stable') trendScore = 75;

    factors.push({
      name: 'Event Trend',
      score: trendScore,
      weight: 25,
      description: `Events ${dashboard.eventsTrend} over past week`,
    });

    if (trendScore < 70) {
      recommendations.push('Review security controls as event volume is increasing');
    }

    // Factor 4: Threat mitigation (weight: 20%)
    const mitigationRate = dashboard.totalSecurityEvents > 0
      ? (dashboard.threatsBlocked / dashboard.totalSecurityEvents) * 100
      : 100;
    const mitigationScore = Math.min(100, mitigationRate * 1.5);

    factors.push({
      name: 'Threat Mitigation',
      score: Math.round(mitigationScore),
      weight: 20,
      description: `${dashboard.threatsBlocked} threats auto-blocked`,
    });

    if (mitigationScore < 70) {
      recommendations.push('Enhance automated threat mitigation capabilities');
    }

    // Calculate weighted score
    const totalScore = factors.reduce(
      (acc, f) => acc + (f.score * f.weight) / 100,
      0,
    );

    return {
      score: Math.round(totalScore),
      dataStatus: liveness.dataStatus,
      lastSeenAt: liveness.lastSeenAt,
      factors,
      recommendations,
    };
  }
}
