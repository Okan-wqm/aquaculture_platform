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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  GeoLocation,
  ThreatIndicatorType,
} from '../contracts/security-vocabulary';
import {
  AnalyzeLoginResultDto,
  AnomalyDetectionConfigDto,
  SecurityEventDto,
  SecurityEventStatsDto,
  SecurityDashboardStatsDto,
  SecurityHealthScoreDto,
  SecurityIncidentDto,
  SecurityIncidentStatsDto,
  ThreatCheckDto,
  ThreatIntelligenceDto,
  ThreatIntelligenceStatsDto,
  toSecurityEventDto,
  toSecurityIncidentDto,
  toThreatIntelligenceDto,
} from '../dto/security-response.dto';
import { SecurityMonitoringService } from '../services/security-monitoring.service';
import {
  createStandardPaginatedResult,
  IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import {
  AdminQueryEncoding,
  AdminResponseContract,
} from '../../shared/admin-response-contract.decorator';
import {
  securityMonitoringSecurityEventDtoContract,
  type SecurityMonitoringSecurityEventDtoDto,
  securityMonitoringSecurityEventDtoPageContract,
  securityMonitoringGetSecurityEventStatsResponseContract,
  type SecurityMonitoringGetSecurityEventStatsResponseDto,
  securityMonitoringSecurityIncidentDtoContract,
  type SecurityMonitoringSecurityIncidentDtoDto,
  securityMonitoringSecurityIncidentDtoPageContract,
  securityMonitoringGetIncidentStatsResponseContract,
  type SecurityMonitoringGetIncidentStatsResponseDto,
  securityMonitoringThreatIntelligenceDtoContract,
  type SecurityMonitoringThreatIntelligenceDtoDto,
  securityMonitoringThreatIntelligenceDtoPageContract,
  securityMonitoringCheckThreatResponseContract,
  type SecurityMonitoringCheckThreatResponseDto,
  securityMonitoringGetThreatIntelStatsResponseContract,
  type SecurityMonitoringGetThreatIntelStatsResponseDto,
  securityMonitoringAnalyzeLoginResponseContract,
  type SecurityMonitoringAnalyzeLoginResponseDto,
  securityMonitoringAnomalyDetectionConfigDtoContract,
  type SecurityMonitoringAnomalyDetectionConfigDtoDto,
  securityMonitoringSecurityDashboardStatsDtoContract,
  type SecurityMonitoringSecurityDashboardStatsDtoDto,
  securityMonitoringSecurityEventDtoArrayContract,
  securityMonitoringSecurityHealthScoreDtoContract,
  type SecurityMonitoringSecurityHealthScoreDtoDto,
} from '../contracts/admin-http-response.contract';

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

const THREAT_INDICATOR_TYPES: readonly ThreatIndicatorType[] = [
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
  indicatorType!: ThreatIndicatorType;

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
  indicatorType?: ThreatIndicatorType;

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
  constructor(private readonly securityMonitoringService: SecurityMonitoringService) {}

  // ============================================================================
  // Security Events
  // ============================================================================

  /**
   * Create security event
   */
  @AdminResponseContract(securityMonitoringSecurityEventDtoContract)
  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  async createSecurityEvent(
    @Body() dto: CreateSecurityEventDto,
  ): Promise<SecurityMonitoringSecurityEventDtoDto> {
    return toSecurityEventDto(
      await this.securityMonitoringService.createSecurityEvent({
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
      }),
    );
  }

  /**
   * Get security event by ID
   */
  @AdminResponseContract(securityMonitoringSecurityEventDtoContract)
  @Get('events/:id')
  async getSecurityEvent(@Param('id') id: string): Promise<SecurityMonitoringSecurityEventDtoDto> {
    return toSecurityEventDto(await this.securityMonitoringService.getSecurityEvent(id));
  }

  /**
   * Query security events
   */
  @AdminResponseContract(securityMonitoringSecurityEventDtoPageContract)
  @AdminQueryEncoding({ threatLevel: 'comma-separated' })
  @Get('events')
  async querySecurityEvents(
    @Query() query: QuerySecurityEventsDto,
  ): Promise<IStandardPaginatedResult<SecurityMonitoringSecurityEventDtoDto>> {
    // Parse threat levels from comma-separated string
    const threatLevel = query.threatLevel
      ? (query.threatLevel.split(',') as ThreatLevel[])
      : undefined;

    const result = await this.securityMonitoringService.querySecurityEvents({
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
    return createStandardPaginatedResult(
      result.items.map(toSecurityEventDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  /**
   * Update security event status
   */
  @AdminResponseContract(securityMonitoringSecurityEventDtoContract)
  @Put('events/:id/status')
  async updateSecurityEventStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSecurityEventStatusDto,
  ): Promise<SecurityMonitoringSecurityEventDtoDto> {
    return toSecurityEventDto(
      await this.securityMonitoringService.updateSecurityEventStatus(id, dto.status, {
        assignedTo: dto.assignedTo,
        assignedToName: dto.assignedToName,
        investigationNotes: dto.investigationNotes,
        resolution: dto.resolution,
        resolvedBy: dto.resolvedBy,
      }),
    );
  }

  /**
   * Get security event statistics
   */
  @AdminResponseContract(securityMonitoringGetSecurityEventStatsResponseContract)
  @Get('events/stats/summary')
  async getSecurityEventStats(): Promise<SecurityMonitoringGetSecurityEventStatsResponseDto> {
    const result = await this.securityMonitoringService.querySecurityEvents({
      page: 1,
      limit: 10000,
    });

    const stats = {
      total: result.total,
      byThreatLevel: {} as Record<string, number>,
      byEventType: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
    };

    for (const event of result.items) {
      stats.byThreatLevel[event.threatLevel] = (stats.byThreatLevel[event.threatLevel] || 0) + 1;
      stats.byEventType[event.eventType] = (stats.byEventType[event.eventType] || 0) + 1;
      stats.byStatus[event.status] = (stats.byStatus[event.status] || 0) + 1;
    }

    return stats;
  }

  // ============================================================================
  // Security Incidents
  // ============================================================================

  /**
   * Get incident by ID
   */
  @AdminResponseContract(securityMonitoringSecurityIncidentDtoContract)
  @Get('incidents/:id')
  async getIncident(@Param('id') id: string): Promise<SecurityMonitoringSecurityIncidentDtoDto> {
    return toSecurityIncidentDto(await this.securityMonitoringService.getIncident(id));
  }

  /**
   * Query incidents
   */
  @AdminResponseContract(securityMonitoringSecurityIncidentDtoPageContract)
  @Get('incidents')
  async queryIncidents(
    @Query() query: QueryIncidentsDto,
  ): Promise<IStandardPaginatedResult<SecurityMonitoringSecurityIncidentDtoDto>> {
    const result = await this.securityMonitoringService.queryIncidents({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      status: query.status,
      severity: query.severity,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
    return createStandardPaginatedResult(
      result.items.map(toSecurityIncidentDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  /**
   * Update incident
   */
  @AdminResponseContract(securityMonitoringSecurityIncidentDtoContract)
  @Put('incidents/:id')
  async updateIncident(
    @Param('id') id: string,
    @Body() dto: UpdateIncidentDto,
  ): Promise<SecurityMonitoringSecurityIncidentDtoDto> {
    return toSecurityIncidentDto(
      await this.securityMonitoringService.updateIncident(
        id,
        dto,
        'admin', // Would come from auth context
        'Admin User',
      ),
    );
  }

  /**
   * Get incident statistics
   */
  @AdminResponseContract(securityMonitoringGetIncidentStatsResponseContract)
  @Get('incidents/stats/summary')
  async getIncidentStats(): Promise<SecurityMonitoringGetIncidentStatsResponseDto> {
    const result = await this.securityMonitoringService.queryIncidents({
      page: 1,
      limit: 10000,
    });

    const stats = {
      total: result.total,
      byStatus: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
    };

    for (const incident of result.items) {
      stats.byStatus[incident.status] = (stats.byStatus[incident.status] || 0) + 1;
      stats.bySeverity[incident.severity] = (stats.bySeverity[incident.severity] || 0) + 1;
    }

    return stats;
  }

  // ============================================================================
  // Threat Intelligence
  // ============================================================================

  /**
   * Add threat indicator
   */
  @AdminResponseContract(securityMonitoringThreatIntelligenceDtoContract)
  @Post('threat-intelligence')
  @HttpCode(HttpStatus.CREATED)
  async addThreatIndicator(
    @Body() dto: AddThreatIndicatorDto,
  ): Promise<SecurityMonitoringThreatIntelligenceDtoDto> {
    return toThreatIntelligenceDto(
      await this.securityMonitoringService.addThreatIndicator({
        indicatorType: dto.indicatorType,
        value: dto.value,
        threatLevel: dto.threatLevel,
        source: dto.source,
        description: dto.description,
        threatTypes: dto.threatTypes,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      }),
    );
  }

  /**
   * Query threat intelligence
   */
  @AdminResponseContract(securityMonitoringThreatIntelligenceDtoPageContract)
  @Get('threat-intelligence')
  async queryThreatIntelligence(
    @Query() query: QueryThreatIntelligenceDto,
  ): Promise<IStandardPaginatedResult<SecurityMonitoringThreatIntelligenceDtoDto>> {
    const result = await this.securityMonitoringService.queryThreatIntelligence({
      page: query.page ? parseInt(String(query.page), 10) : 1,
      limit: query.limit ? parseInt(String(query.limit), 10) : 20,
      indicatorType: query.indicatorType,
      threatLevel: query.threatLevel,
      isActive: query.isActive,
      searchQuery: query.searchQuery,
    });
    return createStandardPaginatedResult(
      result.items.map(toThreatIntelligenceDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  /**
   * Check if IP is a known threat
   */
  @AdminResponseContract(securityMonitoringCheckThreatResponseContract)
  @Get('threat-intelligence/check/:ip')
  async checkThreat(@Param('ip') ip: string): Promise<SecurityMonitoringCheckThreatResponseDto> {
    const threat = await this.securityMonitoringService.checkThreatIntelligence(ip);
    return {
      isThreat: threat !== null,
      threat: threat ? toThreatIntelligenceDto(threat) : null,
    };
  }

  /**
   * Get threat intelligence statistics
   */
  @AdminResponseContract(securityMonitoringGetThreatIntelStatsResponseContract)
  @Get('threat-intelligence/stats')
  async getThreatIntelStats(): Promise<SecurityMonitoringGetThreatIntelStatsResponseDto> {
    const result = await this.securityMonitoringService.queryThreatIntelligence({
      page: 1,
      limit: 10000,
      isActive: true,
    });

    const stats = {
      total: result.total,
      byIndicatorType: {} as Record<string, number>,
      byThreatLevel: {} as Record<string, number>,
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
  @AdminResponseContract(securityMonitoringAnalyzeLoginResponseContract)
  @Post('analyze/login')
  @HttpCode(HttpStatus.OK)
  async analyzeLogin(
    @Body() dto: AnalyzeLoginDto,
  ): Promise<SecurityMonitoringAnalyzeLoginResponseDto> {
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
  @AdminResponseContract(securityMonitoringAnomalyDetectionConfigDtoContract)
  @Get('config/anomaly-detection')
  getAnomalyConfig(): SecurityMonitoringAnomalyDetectionConfigDtoDto {
    return this.securityMonitoringService.getAnomalyConfig();
  }

  // ============================================================================
  // Dashboard
  // ============================================================================

  /**
   * Get security dashboard statistics
   */
  @AdminResponseContract(securityMonitoringSecurityDashboardStatsDtoContract)
  @Get('dashboard')
  async getDashboardStats(): Promise<SecurityMonitoringSecurityDashboardStatsDtoDto> {
    return this.securityMonitoringService.getSecurityDashboardStats();
  }

  /**
   * Get real-time security alerts (unresolved events)
   */
  @AdminResponseContract(securityMonitoringSecurityEventDtoArrayContract)
  @Get('alerts/realtime')
  async getRealtimeAlerts(
    @Query('limit') limit?: number,
  ): Promise<SecurityMonitoringSecurityEventDtoDto[]> {
    const result = await this.securityMonitoringService.querySecurityEvents({
      page: 1,
      limit: limit ? parseInt(String(limit), 10) : 10,
      status: 'detected',
    });

    // Sort by threat level (critical first) and date
    return [...result.items]
      .sort((a, b) => {
        const threatOrder: Record<ThreatLevel, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
        };
        const levelDiff = (threatOrder[a.threatLevel] ?? 4) - (threatOrder[b.threatLevel] ?? 4);
        if (levelDiff !== 0) return levelDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .map(toSecurityEventDto);
  }

  /**
   * Get security health score
   */
  @AdminResponseContract(securityMonitoringSecurityHealthScoreDtoContract)
  @Get('health-score')
  async getHealthScore(): Promise<SecurityMonitoringSecurityHealthScoreDtoDto> {
    const dashboard = await this.securityMonitoringService.getSecurityDashboardStats();

    const factors: Array<{
      name: string;
      score: number;
      weight: number;
      description: string;
    }> = [];
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
    const mitigationRate =
      dashboard.totalSecurityEvents > 0
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
    const totalScore = factors.reduce((acc, f) => acc + (f.score * f.weight) / 100, 0);

    return {
      score: Math.round(totalScore),
      factors,
      recommendations,
    };
  }
}
