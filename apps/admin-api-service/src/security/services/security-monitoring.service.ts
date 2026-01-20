/**
 * Security Monitoring Service
 *
 * Anomaly detection, threat intelligence, vulnerability scanning,
 * incident response, and real-time security monitoring.
 */

import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan, Between, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SecurityEvent,
  SecurityEventType,
  SecurityEventStatus,
  ThreatLevel,
  SecurityIncident,
  IncidentStatus,
  IncidentSeverity,
  ThreatIntelligence,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
  GeoLocation,
  AnomalyDetails,
} from '../entities/security.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface AnomalyDetectionConfig {
  // Login anomalies
  failedLoginThreshold: number;
  failedLoginWindowMinutes: number;
  bruteForceThreshold: number;
  geoAnomalyEnabled: boolean;

  // API anomalies
  apiAbuseThreshold: number;
  apiAbuseWindowMinutes: number;
  rateLimitAbuseEnabled: boolean;

  // Session anomalies
  concurrentSessionLimit: number;
  sessionHijackingDetection: boolean;

  // Time anomalies
  offHoursThreshold: number;
  offHoursStart: number;
  offHoursEnd: number;
}

export interface ThreatIntelFeed {
  id: string;
  name: string;
  url: string;
  type: 'ip' | 'domain' | 'hash' | 'mixed';
  updateFrequency: 'hourly' | 'daily' | 'weekly';
  lastUpdated?: Date;
  isActive: boolean;
}

export interface SecurityDashboardStats {
  // Overview
  totalSecurityEvents: number;
  criticalEvents: number;
  activeIncidents: number;
  threatsBlocked: number;

  // Trends
  eventsLast24h: number;
  eventsLast7d: number;
  eventsLast30d: number;
  eventsTrend: 'increasing' | 'decreasing' | 'stable';

  // By type
  eventsByType: Record<SecurityEventType, number>;
  eventsBySeverity: Record<ThreatLevel, number>;

  // Top threats
  topSourceIPs: { ip: string; count: number; threatLevel: ThreatLevel }[];
  topTargetedUsers: { userId: string; userName: string; count: number }[];
  topEventTypes: { type: SecurityEventType; count: number }[];

  // Timeline
  eventsTimeline: { date: string; critical: number; high: number; medium: number; low: number }[];
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_ANOMALY_CONFIG: AnomalyDetectionConfig = {
  failedLoginThreshold: 5,
  failedLoginWindowMinutes: 15,
  bruteForceThreshold: 10,
  geoAnomalyEnabled: true,
  apiAbuseThreshold: 1000,
  apiAbuseWindowMinutes: 5,
  rateLimitAbuseEnabled: true,
  concurrentSessionLimit: 5,
  sessionHijackingDetection: true,
  offHoursThreshold: 100,
  offHoursStart: 22,
  offHoursEnd: 6,
};

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class SecurityMonitoringService implements OnModuleInit {
  private readonly logger = new Logger(SecurityMonitoringService.name);
  private config: AnomalyDetectionConfig = DEFAULT_ANOMALY_CONFIG;
  private knownGoodIPs: Set<string> = new Set();
  private threatIntelFeeds: ThreatIntelFeed[] = [];

  constructor(
    @InjectRepository(SecurityEvent)
    private readonly securityEventRepository: Repository<SecurityEvent>,
    @InjectRepository(SecurityIncident)
    private readonly incidentRepository: Repository<SecurityIncident>,
    @InjectRepository(ThreatIntelligence)
    private readonly threatIntelRepository: Repository<ThreatIntelligence>,
    @InjectRepository(LoginAttempt)
    private readonly loginAttemptRepository: Repository<LoginAttempt>,
    @InjectRepository(ApiUsageLog)
    private readonly apiUsageRepository: Repository<ApiUsageLog>,
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadThreatIntelligence();
    this.initializeFeeds();
  }

  // ============================================================================
  // Security Event Management
  // ============================================================================

  /**
   * Create security event
   */
  async createSecurityEvent(params: {
    eventType: SecurityEventType;
    threatLevel: ThreatLevel;
    title: string;
    description: string;
    ipAddress: string;
    geoLocation?: GeoLocation;
    tenantId?: string;
    userId?: string;
    userName?: string;
    targetResource?: string;
    targetEndpoint?: string;
    detectionSource: string;
    confidenceScore?: number;
    anomalyDetails?: AnomalyDetails;
    rawData?: Record<string, unknown>;
    relatedActivityIds?: string[];
    autoMitigated?: boolean;
    mitigationActions?: string[];
  }): Promise<SecurityEvent> {
    const event = this.securityEventRepository.create({
      eventType: params.eventType,
      threatLevel: params.threatLevel,
      status: 'detected',
      title: params.title,
      description: params.description,
      ipAddress: params.ipAddress,
      geoLocation: params.geoLocation || null,
      tenantId: params.tenantId || null,
      userId: params.userId || null,
      userName: params.userName || null,
      targetResource: params.targetResource || null,
      targetEndpoint: params.targetEndpoint || null,
      detectionSource: params.detectionSource,
      confidenceScore: params.confidenceScore || null,
      anomalyDetails: params.anomalyDetails || null,
      rawData: params.rawData || null,
      relatedActivityIds: params.relatedActivityIds || null,
      autoMitigated: params.autoMitigated ?? false,
      mitigationActions: params.mitigationActions || null,
    });

    const saved = await this.securityEventRepository.save(event);

    // Auto-escalate critical events
    if (params.threatLevel === 'critical') {
      await this.escalateToIncident(saved);
    }

    this.logger.warn(`Security event detected: ${params.eventType} - ${params.title}`);

    return saved;
  }

  /**
   * Get security event by ID
   */
  async getSecurityEvent(id: string): Promise<SecurityEvent> {
    const event = await this.securityEventRepository.findOne({ where: { id } });
    if (!event) {
      throw new NotFoundException(`Security event not found: ${id}`);
    }
    return event;
  }

  /**
   * Query security events
   */
  async querySecurityEvents(options: {
    page?: number;
    limit?: number;
    eventType?: SecurityEventType;
    threatLevel?: ThreatLevel[];
    status?: SecurityEventStatus;
    ipAddress?: string;
    tenantId?: string;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
    searchQuery?: string;
  }): Promise<{
    data: SecurityEvent[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 50,
      eventType,
      threatLevel,
      status,
      ipAddress,
      tenantId,
      userId,
      startDate,
      endDate,
      searchQuery,
    } = options;

    const qb = this.securityEventRepository.createQueryBuilder('event');

    if (eventType) qb.andWhere('event.eventType = :eventType', { eventType });
    if (threatLevel?.length) qb.andWhere('event.threatLevel IN (:...threatLevel)', { threatLevel });
    if (status) qb.andWhere('event.status = :status', { status });
    if (ipAddress) qb.andWhere('event.ipAddress = :ipAddress', { ipAddress });
    if (tenantId) qb.andWhere('event.tenantId = :tenantId', { tenantId });
    if (userId) qb.andWhere('event.userId = :userId', { userId });
    if (startDate) qb.andWhere('event.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('event.createdAt <= :endDate', { endDate });
    if (searchQuery) {
      qb.andWhere(
        '(event.title ILIKE :search OR event.description ILIKE :search)',
        { search: `%${searchQuery}%` },
      );
    }

    qb.orderBy('event.createdAt', 'DESC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Update security event status
   */
  async updateSecurityEventStatus(
    id: string,
    status: SecurityEventStatus,
    params?: {
      assignedTo?: string;
      assignedToName?: string;
      investigationNotes?: string;
      resolution?: string;
      resolvedBy?: string;
    },
  ): Promise<SecurityEvent> {
    const event = await this.getSecurityEvent(id);

    event.status = status;

    if (params?.assignedTo) {
      event.assignedTo = params.assignedTo;
      event.assignedToName = params.assignedToName || null;
      event.assignedAt = new Date();
    }

    if (params?.investigationNotes) {
      event.investigationNotes = params.investigationNotes;
    }

    if (status === 'mitigated' || status === 'false_positive') {
      event.resolution = params?.resolution || null;
      event.resolvedAt = new Date();
      event.resolvedBy = params?.resolvedBy || null;
    }

    return this.securityEventRepository.save(event);
  }

  // ============================================================================
  // Anomaly Detection
  // ============================================================================

  /**
   * Analyze login attempt for anomalies
   */
  async analyzeLoginAttempt(params: {
    email: string;
    ipAddress: string;
    success: boolean;
    geoLocation?: GeoLocation;
    userId?: string;
    tenantId?: string;
  }): Promise<void> {
    // Check for brute force
    await this.checkBruteForce(params.email, params.ipAddress);

    // Check for credential stuffing
    await this.checkCredentialStuffing(params.ipAddress);

    // Check for geo anomaly
    if (params.geoLocation && params.userId) {
      await this.checkGeoAnomaly(params.userId, params.geoLocation, params.ipAddress);
    }

    // Check for time anomaly
    await this.checkTimeAnomaly(params.ipAddress, params.userId);
  }

  /**
   * Check for brute force attack
   */
  private async checkBruteForce(email: string, ipAddress: string): Promise<void> {
    const since = new Date(Date.now() - this.config.failedLoginWindowMinutes * 60 * 1000);

    // Check by email
    const failedByEmail = await this.loginAttemptRepository.count({
      where: {
        email,
        success: false,
        createdAt: MoreThan(since),
      },
    });

    if (failedByEmail >= this.config.failedLoginThreshold) {
      await this.createSecurityEvent({
        eventType: 'brute_force_attempt',
        threatLevel: failedByEmail >= this.config.bruteForceThreshold ? 'high' : 'medium',
        title: `Brute force attack detected on account: ${email}`,
        description: `${failedByEmail} failed login attempts in ${this.config.failedLoginWindowMinutes} minutes`,
        ipAddress,
        detectionSource: 'anomaly_detection',
        confidenceScore: Math.min(failedByEmail / this.config.bruteForceThreshold, 1),
        anomalyDetails: {
          type: 'brute_force',
          score: failedByEmail,
          threshold: this.config.failedLoginThreshold,
          baseline: { normalFailures: 2 },
          current: { failures: failedByEmail },
          factors: ['high_failure_rate', 'short_time_window'],
        },
        autoMitigated: failedByEmail >= this.config.bruteForceThreshold,
        mitigationActions: failedByEmail >= this.config.bruteForceThreshold
          ? ['account_locked', 'ip_blocked_temp']
          : undefined,
      });
    }

    // Check by IP
    const failedByIP = await this.loginAttemptRepository.count({
      where: {
        ipAddress,
        success: false,
        createdAt: MoreThan(since),
      },
    });

    if (failedByIP >= this.config.bruteForceThreshold) {
      await this.createSecurityEvent({
        eventType: 'brute_force_attempt',
        threatLevel: 'critical',
        title: `Distributed brute force attack from IP: ${ipAddress}`,
        description: `${failedByIP} failed login attempts against multiple accounts`,
        ipAddress,
        detectionSource: 'anomaly_detection',
        confidenceScore: 0.95,
        autoMitigated: true,
        mitigationActions: ['ip_blocked'],
      });

      // Add to threat intelligence
      await this.addThreatIndicator({
        indicatorType: 'ip',
        value: ipAddress,
        threatLevel: 'high',
        source: 'internal_detection',
        description: 'Brute force attack source',
        threatTypes: ['brute_force'],
      });
    }
  }

  /**
   * Check for credential stuffing
   */
  private async checkCredentialStuffing(ipAddress: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000); // Last hour

    const uniqueEmails = await this.loginAttemptRepository
      .createQueryBuilder('attempt')
      .select('COUNT(DISTINCT attempt.email)', 'count')
      .where('attempt.ipAddress = :ipAddress', { ipAddress })
      .andWhere('attempt.success = :success', { success: false })
      .andWhere('attempt.createdAt > :since', { since })
      .getRawOne();

    const emailCount = parseInt(uniqueEmails?.count || '0', 10);

    if (emailCount >= 20) {
      await this.createSecurityEvent({
        eventType: 'credential_stuffing',
        threatLevel: 'critical',
        title: `Credential stuffing attack detected from IP: ${ipAddress}`,
        description: `${emailCount} unique accounts targeted in the last hour`,
        ipAddress,
        detectionSource: 'anomaly_detection',
        confidenceScore: 0.9,
        autoMitigated: true,
        mitigationActions: ['ip_blocked', 'rate_limited'],
      });
    }
  }

  /**
   * Check for geographic anomaly
   */
  private async checkGeoAnomaly(
    userId: string,
    currentGeo: GeoLocation,
    ipAddress: string,
  ): Promise<void> {
    if (!this.config.geoAnomalyEnabled) return;

    // Get user's recent login locations
    const recentLogins = await this.loginAttemptRepository.find({
      where: {
        userId,
        success: true,
        createdAt: MoreThan(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)), // Last 30 days
      },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    if (recentLogins.length < 3) return; // Not enough history

    // Check if current location is anomalous
    const knownCountries = new Set(
      recentLogins
        .filter((l) => l.geoLocation?.countryCode)
        .map((l) => l.geoLocation!.countryCode),
    );

    if (knownCountries.size > 0 && !knownCountries.has(currentGeo.countryCode)) {
      // Calculate impossible travel
      const lastLogin = recentLogins[0];
      const lastLoginGeo = lastLogin?.geoLocation;
      if (lastLogin && lastLoginGeo) {
        const timeDiff = Date.now() - lastLogin.createdAt.getTime();
        const hoursElapsed = timeDiff / (1000 * 60 * 60);

        // Simple check: if less than 2 hours and different country, flag it
        if (hoursElapsed < 2) {
          await this.createSecurityEvent({
            eventType: 'geo_anomaly',
            threatLevel: 'high',
            title: `Impossible travel detected for user`,
            description: `Login from ${currentGeo.country} after ${hoursElapsed.toFixed(1)}h from ${lastLoginGeo.country}`,
            ipAddress,
            userId,
            detectionSource: 'anomaly_detection',
            confidenceScore: 0.85,
            anomalyDetails: {
              type: 'impossible_travel',
              score: 0.85,
              threshold: 0.7,
              baseline: { knownCountries: Array.from(knownCountries) },
              current: { country: currentGeo.countryCode, hoursElapsed },
              factors: ['new_country', 'short_time_window'],
            },
          });
        }
      }
    }
  }

  /**
   * Check for time anomaly (off-hours activity)
   */
  private async checkTimeAnomaly(ipAddress: string, userId?: string): Promise<void> {
    const currentHour = new Date().getHours();
    const isOffHours = currentHour >= this.config.offHoursEnd && currentHour < this.config.offHoursStart;

    if (!isOffHours) return;

    const since = new Date(Date.now() - 60 * 60 * 1000); // Last hour

    const offHoursActivity = await this.loginAttemptRepository.count({
      where: {
        ...(userId ? { userId } : { ipAddress }),
        createdAt: MoreThan(since),
      },
    });

    if (offHoursActivity >= this.config.offHoursThreshold) {
      await this.createSecurityEvent({
        eventType: 'time_anomaly',
        threatLevel: 'medium',
        title: 'Unusual off-hours activity detected',
        description: `${offHoursActivity} activities during off-hours (${this.config.offHoursEnd}:00 - ${this.config.offHoursStart}:00)`,
        ipAddress,
        userId: userId || undefined,
        detectionSource: 'anomaly_detection',
        confidenceScore: 0.7,
      });
    }
  }

  /**
   * Check for API abuse
   */
  async checkApiAbuse(params: {
    tenantId?: string;
    userId?: string;
    ipAddress: string;
    endpoint: string;
    rateLimitExceeded: boolean;
  }): Promise<void> {
    if (params.rateLimitExceeded && this.config.rateLimitAbuseEnabled) {
      const since = new Date(Date.now() - this.config.apiAbuseWindowMinutes * 60 * 1000);

      const abuseCount = await this.apiUsageRepository.count({
        where: {
          ipAddress: params.ipAddress,
          rateLimitExceeded: true,
          createdAt: MoreThan(since),
        },
      });

      if (abuseCount >= 5) {
        await this.createSecurityEvent({
          eventType: 'api_abuse',
          threatLevel: 'high',
          title: `API abuse detected from IP: ${params.ipAddress}`,
          description: `${abuseCount} rate limit violations in ${this.config.apiAbuseWindowMinutes} minutes`,
          ipAddress: params.ipAddress,
          tenantId: params.tenantId,
          userId: params.userId,
          targetEndpoint: params.endpoint,
          detectionSource: 'rate_limiter',
          confidenceScore: 0.9,
          autoMitigated: true,
          mitigationActions: ['rate_limited', 'ip_throttled'],
        });
      }
    }
  }

  /**
   * Check for session hijacking
   */
  async checkSessionHijacking(params: {
    sessionToken: string;
    userId: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<boolean> {
    if (!this.config.sessionHijackingDetection) return false;

    const session = await this.sessionRepository.findOne({
      where: { sessionToken: params.sessionToken, isActive: true },
    });

    if (!session) return false;

    // Check if IP changed
    if (session.ipAddress !== params.ipAddress) {
      await this.createSecurityEvent({
        eventType: 'session_hijacking',
        threatLevel: 'critical',
        title: `Potential session hijacking detected`,
        description: `Session IP changed from ${session.ipAddress} to ${params.ipAddress}`,
        ipAddress: params.ipAddress,
        userId: params.userId,
        detectionSource: 'session_monitor',
        confidenceScore: 0.8,
        rawData: {
          originalIP: session.ipAddress,
          newIP: params.ipAddress,
          sessionId: session.id,
        },
      });

      // Terminate the session
      await this.sessionRepository.update(
        { id: session.id },
        {
          isActive: false,
          terminatedAt: new Date(),
          terminationReason: 'security',
        },
      );

      return true;
    }

    return false;
  }

  // ============================================================================
  // Threat Intelligence
  // ============================================================================

  /**
   * Load threat intelligence data
   */
  private async loadThreatIntelligence(): Promise<void> {
    const activeThreats = await this.threatIntelRepository.count({
      where: { isActive: true },
    });
    this.logger.log(`Loaded ${activeThreats} active threat indicators`);
  }

  /**
   * Initialize threat intel feeds
   */
  private initializeFeeds(): void {
    this.threatIntelFeeds = [
      {
        id: 'feed-1',
        name: 'Internal Blocklist',
        url: 'internal',
        type: 'ip',
        updateFrequency: 'hourly',
        isActive: true,
      },
      // Additional feeds would be configured here
    ];
  }

  /**
   * Check IP against threat intelligence
   */
  async checkThreatIntelligence(ipAddress: string): Promise<ThreatIntelligence | null> {
    const threat = await this.threatIntelRepository.findOne({
      where: {
        indicatorType: 'ip',
        value: ipAddress,
        isActive: true,
      },
    });

    if (threat) {
      // Update hit count
      await this.threatIntelRepository.increment(
        { id: threat.id },
        'hitCount',
        1,
      );
      await this.threatIntelRepository.update(
        { id: threat.id },
        { lastSeenAt: new Date() },
      );

      // Create security event
      await this.createSecurityEvent({
        eventType: 'ip_blacklisted',
        threatLevel: threat.threatLevel,
        title: `Blacklisted IP detected: ${ipAddress}`,
        description: threat.description || 'IP found in threat intelligence database',
        ipAddress,
        detectionSource: 'threat_intelligence',
        confidenceScore: threat.confidence,
        autoMitigated: true,
        mitigationActions: ['request_blocked'],
      });
    }

    return threat;
  }

  /**
   * Add threat indicator
   */
  async addThreatIndicator(params: {
    indicatorType: ThreatIntelligence['indicatorType'];
    value: string;
    threatLevel: ThreatLevel;
    source: string;
    description?: string;
    threatTypes?: string[];
    validUntil?: Date;
  }): Promise<ThreatIntelligence> {
    // Check if already exists
    const existing = await this.threatIntelRepository.findOne({
      where: {
        indicatorType: params.indicatorType,
        value: params.value,
      },
    });

    if (existing) {
      // Update existing
      existing.threatLevel = params.threatLevel;
      existing.lastSeenAt = new Date();
      existing.hitCount += 1;
      return this.threatIntelRepository.save(existing);
    }

    const indicator = this.threatIntelRepository.create({
      indicatorType: params.indicatorType,
      value: params.value,
      threatLevel: params.threatLevel,
      source: params.source,
      description: params.description || null,
      threatTypes: params.threatTypes || null,
      confidence: 0.8,
      isActive: true,
      validUntil: params.validUntil || null,
      firstSeenAt: new Date(),
      hitCount: 1,
    });

    return this.threatIntelRepository.save(indicator);
  }

  /**
   * Query threat intelligence
   */
  async queryThreatIntelligence(options: {
    page?: number;
    limit?: number;
    indicatorType?: ThreatIntelligence['indicatorType'];
    threatLevel?: ThreatLevel;
    isActive?: boolean;
    searchQuery?: string;
  }): Promise<{
    data: ThreatIntelligence[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 50, indicatorType, threatLevel, isActive, searchQuery } = options;

    const qb = this.threatIntelRepository.createQueryBuilder('threat');

    if (indicatorType) qb.andWhere('threat.indicatorType = :indicatorType', { indicatorType });
    if (threatLevel) qb.andWhere('threat.threatLevel = :threatLevel', { threatLevel });
    if (isActive !== undefined) qb.andWhere('threat.isActive = :isActive', { isActive });
    if (searchQuery) {
      qb.andWhere(
        '(threat.value ILIKE :search OR threat.description ILIKE :search)',
        { search: `%${searchQuery}%` },
      );
    }

    qb.orderBy('threat.lastSeenAt', 'DESC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  // ============================================================================
  // Incident Management
  // ============================================================================

  /**
   * Escalate security event to incident
   */
  async escalateToIncident(event: SecurityEvent): Promise<SecurityIncident> {
    const incidentNumber = await this.generateIncidentNumber();

    const incident = this.incidentRepository.create({
      incidentNumber,
      title: event.title,
      description: event.description,
      severity: this.mapThreatLevelToSeverity(event.threatLevel),
      status: 'open',
      category: event.eventType,
      affectedTenants: event.tenantId ? [event.tenantId] : null,
      detectedAt: event.createdAt,
      relatedSecurityEvents: [event.id],
      timeline: [
        {
          timestamp: new Date(),
          action: 'Incident created',
          actor: 'System',
          details: `Auto-escalated from security event ${event.id}`,
        },
      ],
      createdBy: 'system',
    });

    const saved = await this.incidentRepository.save(incident);

    // Update event status
    await this.securityEventRepository.update(
      { id: event.id },
      { status: 'escalated' },
    );

    this.logger.warn(`Security incident created: ${incidentNumber}`);

    return saved;
  }

  /**
   * Get incident by ID
   */
  async getIncident(id: string): Promise<SecurityIncident> {
    const incident = await this.incidentRepository.findOne({ where: { id } });
    if (!incident) {
      throw new NotFoundException(`Incident not found: ${id}`);
    }
    return incident;
  }

  /**
   * Update incident
   */
  async updateIncident(
    id: string,
    data: Partial<{
      status: IncidentStatus;
      severity: IncidentSeverity;
      leadInvestigator: string;
      leadInvestigatorName: string;
      teamMembers: string[];
      rootCauseAnalysis: string;
      lessonsLearned: string;
      impactDescription: string;
    }>,
    actorId: string,
    actorName: string,
  ): Promise<SecurityIncident> {
    const incident = await this.getIncident(id);

    // Track status changes in timeline
    if (data.status && data.status !== incident.status) {
      if (!incident.timeline) incident.timeline = [];
      incident.timeline.push({
        timestamp: new Date(),
        action: `Status changed to ${data.status}`,
        actor: actorName,
      });

      // Update timestamp fields
      switch (data.status) {
        case 'contained':
          incident.containedAt = new Date();
          break;
        case 'eradicated':
          incident.eradicatedAt = new Date();
          break;
        case 'recovered':
          incident.recoveredAt = new Date();
          break;
        case 'closed':
          incident.closedAt = new Date();
          break;
      }
    }

    Object.assign(incident, data);

    return this.incidentRepository.save(incident);
  }

  /**
   * Query incidents
   */
  async queryIncidents(options: {
    page?: number;
    limit?: number;
    status?: IncidentStatus;
    severity?: IncidentSeverity;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    data: SecurityIncident[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status, severity, startDate, endDate } = options;

    const qb = this.incidentRepository.createQueryBuilder('incident');

    if (status) qb.andWhere('incident.status = :status', { status });
    if (severity) qb.andWhere('incident.severity = :severity', { severity });
    if (startDate) qb.andWhere('incident.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('incident.createdAt <= :endDate', { endDate });

    qb.orderBy('incident.createdAt', 'DESC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  // ============================================================================
  // Dashboard & Statistics
  // ============================================================================

  /**
   * Get security dashboard stats
   */
  async getSecurityDashboardStats(): Promise<SecurityDashboardStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Overview counts
    const totalSecurityEvents = await this.securityEventRepository.count();
    const criticalEvents = await this.securityEventRepository.count({
      where: { threatLevel: 'critical' },
    });
    const activeIncidents = await this.incidentRepository.count({
      where: { status: In(['open', 'investigating', 'contained']) },
    });
    const threatsBlocked = await this.securityEventRepository.count({
      where: { autoMitigated: true },
    });

    // Events over time
    const eventsLast24h = await this.securityEventRepository.count({
      where: { createdAt: MoreThan(last24h) },
    });
    const eventsLast7d = await this.securityEventRepository.count({
      where: { createdAt: MoreThan(last7d) },
    });
    const eventsLast30d = await this.securityEventRepository.count({
      where: { createdAt: MoreThan(last30d) },
    });

    // Calculate trend
    const previousPeriod = await this.securityEventRepository.count({
      where: { createdAt: Between(new Date(last7d.getTime() - 7 * 24 * 60 * 60 * 1000), last7d) },
    });
    const eventsTrend = eventsLast7d > previousPeriod * 1.1
      ? 'increasing'
      : eventsLast7d < previousPeriod * 0.9
      ? 'decreasing'
      : 'stable';

    // By type
    const typeStats = await this.securityEventRepository
      .createQueryBuilder('event')
      .select('event.eventType', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('event.eventType')
      .getRawMany();

    const eventsByType = {} as Record<SecurityEventType, number>;
    typeStats.forEach((s) => {
      eventsByType[s.type as SecurityEventType] = parseInt(s.count, 10);
    });

    // By severity
    const severityStats = await this.securityEventRepository
      .createQueryBuilder('event')
      .select('event.threatLevel', 'level')
      .addSelect('COUNT(*)', 'count')
      .groupBy('event.threatLevel')
      .getRawMany();

    const eventsBySeverity = {} as Record<ThreatLevel, number>;
    severityStats.forEach((s) => {
      eventsBySeverity[s.level as ThreatLevel] = parseInt(s.count, 10);
    });

    // Top source IPs
    const topSourceIPs = await this.securityEventRepository
      .createQueryBuilder('event')
      .select('event.ipAddress', 'ip')
      .addSelect('event.threatLevel', 'threatLevel')
      .addSelect('COUNT(*)', 'count')
      .groupBy('event.ipAddress')
      .addGroupBy('event.threatLevel')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Top targeted users
    const topTargetedUsers = await this.securityEventRepository
      .createQueryBuilder('event')
      .select('event.userId', 'userId')
      .addSelect('event.userName', 'userName')
      .addSelect('COUNT(*)', 'count')
      .where('event.userId IS NOT NULL')
      .groupBy('event.userId')
      .addGroupBy('event.userName')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Top event types
    const topEventTypes = await this.securityEventRepository
      .createQueryBuilder('event')
      .select('event.eventType', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('event.eventType')
      .orderBy('count', 'DESC')
      .limit(5)
      .getRawMany();

    // Timeline (last 30 days)
    const timeline = await this.securityEventRepository
      .createQueryBuilder('event')
      .select("DATE(event.createdAt)", 'date')
      .addSelect("SUM(CASE WHEN event.threatLevel = 'critical' THEN 1 ELSE 0 END)", 'critical')
      .addSelect("SUM(CASE WHEN event.threatLevel = 'high' THEN 1 ELSE 0 END)", 'high')
      .addSelect("SUM(CASE WHEN event.threatLevel = 'medium' THEN 1 ELSE 0 END)", 'medium')
      .addSelect("SUM(CASE WHEN event.threatLevel = 'low' THEN 1 ELSE 0 END)", 'low')
      .where('event.createdAt > :since', { since: last30d })
      .groupBy('DATE(event.createdAt)')
      .orderBy('date', 'ASC')
      .getRawMany();

    return {
      totalSecurityEvents,
      criticalEvents,
      activeIncidents,
      threatsBlocked,
      eventsLast24h,
      eventsLast7d,
      eventsLast30d,
      eventsTrend,
      eventsByType,
      eventsBySeverity,
      topSourceIPs: topSourceIPs.map((i) => ({
        ip: i.ip,
        count: parseInt(i.count, 10),
        threatLevel: i.threatLevel,
      })),
      topTargetedUsers: topTargetedUsers.map((u) => ({
        userId: u.userId,
        userName: u.userName || 'Unknown',
        count: parseInt(u.count, 10),
      })),
      topEventTypes: topEventTypes.map((t) => ({
        type: t.type,
        count: parseInt(t.count, 10),
      })),
      eventsTimeline: timeline.map((t) => ({
        date: t.date,
        critical: parseInt(t.critical, 10),
        high: parseInt(t.high, 10),
        medium: parseInt(t.medium, 10),
        low: parseInt(t.low, 10),
      })),
    };
  }

  // ============================================================================
  // Scheduled Tasks
  // ============================================================================

  /**
   * Clean up old threat intelligence
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupThreatIntelligence(): Promise<void> {
    const result = await this.threatIntelRepository.update(
      {
        validUntil: LessThan(new Date()),
        isActive: true,
      },
      { isActive: false },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Deactivated ${result.affected} expired threat indicators`);
    }
  }

  /**
   * Update threat intel feeds
   */
  @Cron(CronExpression.EVERY_HOUR)
  async updateThreatFeeds(): Promise<void> {
    for (const feed of this.threatIntelFeeds) {
      if (!feed.isActive) continue;
      if (feed.updateFrequency !== 'hourly') continue;

      // In production, fetch from actual feeds
      this.logger.debug(`Would update threat feed: ${feed.name}`);
      feed.lastUpdated = new Date();
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private async generateIncidentNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.incidentRepository.count({
      where: {
        createdAt: MoreThan(new Date(`${year}-01-01`)),
      },
    });
    return `INC-${year}-${String(count + 1).padStart(4, '0')}`;
  }

  private mapThreatLevelToSeverity(threatLevel: ThreatLevel): IncidentSeverity {
    switch (threatLevel) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
    }
  }

  /**
   * Get anomaly detection config
   */
  getAnomalyConfig(): AnomalyDetectionConfig {
    return { ...this.config };
  }

  /**
   * Update anomaly detection config
   */
  updateAnomalyConfig(updates: Partial<AnomalyDetectionConfig>): AnomalyDetectionConfig {
    this.config = { ...this.config, ...updates };
    return this.config;
  }
}
