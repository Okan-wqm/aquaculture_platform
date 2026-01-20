/**
 * Compliance Service
 *
 * GDPR, CCPA compliance management, data subject requests,
 * compliance reporting, and data governance.
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, MoreThan, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DataRequest,
  DataRequestType,
  DataRequestStatus,
  ComplianceReport,
  ComplianceType,
  ComplianceViolation,
  ActivityLog,
  SecurityIncident,
} from '../entities/security.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface DataRequestCreateParams {
  requestType: DataRequestType;
  complianceFramework: ComplianceType;
  tenantId: string;
  tenantName: string;
  requesterId?: string;
  requesterName: string;
  requesterEmail: string;
  description: string;
  dataCategories?: string[];
  specificData?: string;
}

export interface ComplianceRequirement {
  id: string;
  framework: ComplianceType;
  requirement: string;
  description: string;
  category: string;
  isMandatory: boolean;
  verificationMethod: string;
}

export interface ComplianceCheckResult {
  requirement: ComplianceRequirement;
  status: 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';
  details: string;
  evidence?: string;
  remediation?: string;
}

export interface DataInventory {
  category: string;
  dataTypes: string[];
  sources: string[];
  purposes: string[];
  retentionPeriod: string;
  legalBasis: string;
  thirdPartySharing: boolean;
  crossBorderTransfer: boolean;
}

// ============================================================================
// Compliance Requirements
// ============================================================================

const GDPR_REQUIREMENTS: ComplianceRequirement[] = [
  {
    id: 'gdpr-1',
    framework: 'gdpr',
    requirement: 'Lawful Basis for Processing',
    description: 'Personal data must be processed lawfully, fairly, and transparently',
    category: 'Data Processing',
    isMandatory: true,
    verificationMethod: 'Review privacy policy and consent mechanisms',
  },
  {
    id: 'gdpr-2',
    framework: 'gdpr',
    requirement: 'Data Subject Rights',
    description: 'Enable data subjects to exercise their rights (access, rectification, deletion)',
    category: 'Data Subject Rights',
    isMandatory: true,
    verificationMethod: 'Check data request handling process',
  },
  {
    id: 'gdpr-3',
    framework: 'gdpr',
    requirement: 'Data Breach Notification',
    description: 'Notify supervisory authority within 72 hours of breach discovery',
    category: 'Breach Management',
    isMandatory: true,
    verificationMethod: 'Review incident response procedures',
  },
  {
    id: 'gdpr-4',
    framework: 'gdpr',
    requirement: 'Data Protection Impact Assessment',
    description: 'Conduct DPIA for high-risk processing activities',
    category: 'Risk Assessment',
    isMandatory: true,
    verificationMethod: 'Review DPIA documentation',
  },
  {
    id: 'gdpr-5',
    framework: 'gdpr',
    requirement: 'Records of Processing Activities',
    description: 'Maintain records of all data processing activities',
    category: 'Documentation',
    isMandatory: true,
    verificationMethod: 'Review processing activity records',
  },
  {
    id: 'gdpr-6',
    framework: 'gdpr',
    requirement: 'Data Minimization',
    description: 'Collect only necessary personal data',
    category: 'Data Collection',
    isMandatory: true,
    verificationMethod: 'Audit data collection forms and processes',
  },
  {
    id: 'gdpr-7',
    framework: 'gdpr',
    requirement: 'Storage Limitation',
    description: 'Retain personal data only as long as necessary',
    category: 'Data Retention',
    isMandatory: true,
    verificationMethod: 'Review retention policies and schedules',
  },
  {
    id: 'gdpr-8',
    framework: 'gdpr',
    requirement: 'Security of Processing',
    description: 'Implement appropriate technical and organizational security measures',
    category: 'Security',
    isMandatory: true,
    verificationMethod: 'Security audit and penetration testing',
  },
];

const RESPONSE_DEADLINES: Record<DataRequestType, number> = {
  access: 30, // 30 days
  deletion: 30,
  portability: 30,
  rectification: 30,
  restriction: 30,
};

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    @InjectRepository(DataRequest)
    private readonly dataRequestRepository: Repository<DataRequest>,
    @InjectRepository(ComplianceReport)
    private readonly reportRepository: Repository<ComplianceReport>,
    @InjectRepository(ActivityLog)
    private readonly activityRepository: Repository<ActivityLog>,
    @InjectRepository(SecurityIncident)
    private readonly incidentRepository: Repository<SecurityIncident>,
  ) {}

  // ============================================================================
  // Data Subject Requests
  // ============================================================================

  /**
   * Create data subject request
   */
  async createDataRequest(params: DataRequestCreateParams): Promise<DataRequest> {
    this.logger.log(`Creating ${params.requestType} request for ${params.requesterEmail}`);

    const requestNumber = await this.generateRequestNumber();
    const deadlineDays = RESPONSE_DEADLINES[params.requestType] || 30;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + deadlineDays);

    const request = this.dataRequestRepository.create({
      requestNumber,
      requestType: params.requestType,
      status: 'pending',
      complianceFramework: params.complianceFramework,
      tenantId: params.tenantId,
      tenantName: params.tenantName,
      requesterId: params.requesterId || null,
      requesterName: params.requesterName,
      requesterEmail: params.requesterEmail,
      description: params.description,
      dataCategories: params.dataCategories || null,
      specificData: params.specificData || null,
      identityVerified: false,
      dueDate,
      auditTrail: [
        {
          timestamp: new Date(),
          action: 'Request created',
          actor: 'System',
          details: `${params.requestType} request submitted`,
        },
      ],
    });

    const saved = await this.dataRequestRepository.save(request);

    // Log activity
    await this.logComplianceActivity('data_request_created', {
      requestId: saved.id,
      requestType: params.requestType,
      tenantId: params.tenantId,
      requesterEmail: params.requesterEmail,
    });

    return saved;
  }

  /**
   * Get data request by ID
   */
  async getDataRequest(id: string): Promise<DataRequest> {
    const request = await this.dataRequestRepository.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Data request not found: ${id}`);
    }
    return request;
  }

  /**
   * Get all data requests with filters
   */
  async getDataRequests(options: {
    page?: number;
    limit?: number;
    tenantId?: string;
    requestType?: DataRequestType;
    status?: DataRequestStatus;
    complianceFramework?: ComplianceType;
    startDate?: Date;
    endDate?: Date;
    overdue?: boolean;
  }): Promise<{
    data: DataRequest[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 20,
      tenantId,
      requestType,
      status,
      complianceFramework,
      startDate,
      endDate,
      overdue,
    } = options;

    const qb = this.dataRequestRepository.createQueryBuilder('request');

    if (tenantId) qb.andWhere('request.tenantId = :tenantId', { tenantId });
    if (requestType) qb.andWhere('request.requestType = :requestType', { requestType });
    if (status) qb.andWhere('request.status = :status', { status });
    if (complianceFramework) qb.andWhere('request.complianceFramework = :complianceFramework', { complianceFramework });
    if (startDate) qb.andWhere('request.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('request.createdAt <= :endDate', { endDate });
    if (overdue) {
      qb.andWhere('request.dueDate < :now', { now: new Date() });
      qb.andWhere('request.status NOT IN (:...completedStatuses)', {
        completedStatuses: ['completed', 'rejected'],
      });
    }

    qb.orderBy('request.dueDate', 'ASC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Update data request
   */
  async updateDataRequest(
    id: string,
    data: Partial<{
      status: DataRequestStatus;
      assignedTo: string;
      assignedToName: string;
      completionNotes: string;
      rejectionReason: string;
    }>,
    actorId: string,
    actorName: string,
  ): Promise<DataRequest> {
    const request = await this.getDataRequest(id);

    // Track changes in audit trail
    const auditEntry = {
      timestamp: new Date(),
      action: this.getStatusChangeDescription(request.status, data.status),
      actor: actorName,
      details: data.completionNotes || data.rejectionReason,
    };

    if (!request.auditTrail) request.auditTrail = [];
    request.auditTrail.push(auditEntry);

    // Update fields
    if (data.status) {
      request.status = data.status;
      if (data.status === 'in_progress' && !request.processingStartedAt) {
        request.processingStartedAt = new Date();
      }
      if (data.status === 'completed') {
        request.completedAt = new Date();
        request.completedBy = actorId;
      }
    }

    if (data.assignedTo) {
      request.assignedTo = data.assignedTo;
      request.assignedToName = data.assignedToName || null;
    }

    if (data.completionNotes) {
      request.completionNotes = data.completionNotes;
    }

    if (data.rejectionReason) {
      request.rejectionReason = data.rejectionReason;
    }

    return this.dataRequestRepository.save(request);
  }

  /**
   * Verify requester identity
   */
  async verifyIdentity(
    id: string,
    verifiedBy: string,
    verificationMethod: string,
  ): Promise<DataRequest> {
    const request = await this.getDataRequest(id);

    request.identityVerified = true;
    request.verifiedAt = new Date();
    request.verifiedBy = verifiedBy;
    request.verificationMethod = verificationMethod;

    request.auditTrail?.push({
      timestamp: new Date(),
      action: 'Identity verified',
      actor: verifiedBy,
      details: `Verification method: ${verificationMethod}`,
    });

    return this.dataRequestRepository.save(request);
  }

  /**
   * Complete data request with delivery
   */
  async completeDataRequest(
    id: string,
    params: {
      completedBy: string;
      completionNotes: string;
      deliveryFormat?: 'json' | 'csv' | 'pdf' | 'xml';
      downloadUrl?: string;
      downloadExpiresAt?: Date;
    },
  ): Promise<DataRequest> {
    const request = await this.getDataRequest(id);

    if (request.status === 'completed') {
      throw new BadRequestException('Request is already completed');
    }

    request.status = 'completed';
    request.completedAt = new Date();
    request.completedBy = params.completedBy;
    request.completionNotes = params.completionNotes;

    if (params.deliveryFormat) {
      request.deliveryFormat = params.deliveryFormat;
      request.downloadUrl = params.downloadUrl || null;
      request.downloadExpiresAt = params.downloadExpiresAt || null;
    }

    request.auditTrail?.push({
      timestamp: new Date(),
      action: 'Request completed',
      actor: params.completedBy,
      details: params.completionNotes,
    });

    return this.dataRequestRepository.save(request);
  }

  /**
   * Record download of data request
   */
  async recordDownload(id: string): Promise<void> {
    await this.dataRequestRepository.increment({ id }, 'downloadCount', 1);
  }

  /**
   * Get overdue requests
   */
  async getOverdueRequests(): Promise<DataRequest[]> {
    return this.dataRequestRepository.find({
      where: {
        dueDate: LessThan(new Date()),
        status: In(['pending', 'in_progress']),
      },
      order: { dueDate: 'ASC' },
    });
  }

  /**
   * Get request statistics
   */
  async getDataRequestStats(options: {
    tenantId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    total: number;
    byStatus: Record<DataRequestStatus, number>;
    byType: Record<DataRequestType, number>;
    avgResponseDays: number;
    overdueCount: number;
    completionRate: number;
  }> {
    const { tenantId, startDate, endDate } = options;

    const qb = this.dataRequestRepository.createQueryBuilder('request');
    if (tenantId) qb.andWhere('request.tenantId = :tenantId', { tenantId });
    if (startDate) qb.andWhere('request.createdAt >= :startDate', { startDate });
    if (endDate) qb.andWhere('request.createdAt <= :endDate', { endDate });

    const all = await qb.getMany();

    // By status
    const byStatus = {} as Record<DataRequestStatus, number>;
    const statuses: DataRequestStatus[] = ['pending', 'in_progress', 'completed', 'rejected', 'expired'];
    statuses.forEach((s) => {
      byStatus[s] = all.filter((r) => r.status === s).length;
    });

    // By type
    const byType = {} as Record<DataRequestType, number>;
    const types: DataRequestType[] = ['access', 'deletion', 'portability', 'rectification', 'restriction'];
    types.forEach((t) => {
      byType[t] = all.filter((r) => r.requestType === t).length;
    });

    // Average response time
    const completedWithTime = all.filter((r) => r.completedAt && r.createdAt);
    const avgResponseDays = completedWithTime.length > 0
      ? completedWithTime.reduce((sum, r) => {
          const days = (r.completedAt!.getTime() - r.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          return sum + days;
        }, 0) / completedWithTime.length
      : 0;

    // Overdue count
    const now = new Date();
    const overdueCount = all.filter(
      (r) => r.dueDate < now && !['completed', 'rejected'].includes(r.status),
    ).length;

    // Completion rate
    const completionRate = all.length > 0
      ? (all.filter((r) => r.status === 'completed').length / all.length) * 100
      : 0;

    return {
      total: all.length,
      byStatus,
      byType,
      avgResponseDays: Math.round(avgResponseDays * 10) / 10,
      overdueCount,
      completionRate: Math.round(completionRate * 10) / 10,
    };
  }

  // ============================================================================
  // Compliance Reporting
  // ============================================================================

  /**
   * Generate compliance report
   */
  async generateComplianceReport(params: {
    complianceType: ComplianceType;
    reportPeriodStart: Date;
    reportPeriodEnd: Date;
    includedTenants?: string[];
    generatedBy: string;
    generatedByName: string;
    isAutoGenerated?: boolean;
  }): Promise<ComplianceReport> {
    this.logger.log(`Generating ${params.complianceType} compliance report`);

    // Gather metrics
    const requestStats = await this.getDataRequestStats({
      startDate: params.reportPeriodStart,
      endDate: params.reportPeriodEnd,
    });

    const incidents = await this.incidentRepository.count({
      where: {
        createdAt: Between(params.reportPeriodStart, params.reportPeriodEnd),
      },
    });

    const dataBreaches = await this.incidentRepository.count({
      where: {
        dataBreached: true,
        createdAt: Between(params.reportPeriodStart, params.reportPeriodEnd),
      },
    });

    // Run compliance checks
    const complianceResults = await this.runComplianceChecks(params.complianceType);
    const violations = complianceResults
      .filter((r) => r.status === 'non_compliant')
      .map((r) => ({
        requirement: r.requirement.requirement,
        description: r.details,
        severity: 'high' as const,
        remediation: r.remediation || 'Review and address non-compliance',
      }));

    const complianceScore = this.calculateComplianceScore(complianceResults);

    // Generate recommendations
    const recommendations = this.generateRecommendations(complianceResults, requestStats);

    const report = this.reportRepository.create({
      title: `${params.complianceType.toUpperCase()} Compliance Report - ${this.formatPeriod(params.reportPeriodStart, params.reportPeriodEnd)}`,
      complianceType: params.complianceType,
      reportPeriodStart: params.reportPeriodStart,
      reportPeriodEnd: params.reportPeriodEnd,
      includedTenants: params.includedTenants || null,
      includesAllTenants: !params.includedTenants || params.includedTenants.length === 0,
      totalDataRequests: requestStats.total,
      completedDataRequests: requestStats.byStatus.completed || 0,
      pendingDataRequests: (requestStats.byStatus.pending || 0) + (requestStats.byStatus.in_progress || 0),
      avgResponseTimeDays: requestStats.avgResponseDays,
      securityIncidents: incidents,
      dataBreaches,
      complianceScore,
      violations: violations.length > 0 ? violations : null,
      recommendations: recommendations.length > 0 ? recommendations : null,
      executiveSummary: this.generateExecutiveSummary(params.complianceType, complianceScore, violations.length),
      detailedFindings: {
        complianceResults,
        requestStats,
        incidentSummary: { total: incidents, breaches: dataBreaches },
      },
      generatedBy: params.generatedBy,
      generatedByName: params.generatedByName,
      isAutoGenerated: params.isAutoGenerated ?? false,
    });

    return this.reportRepository.save(report);
  }

  /**
   * Get compliance report by ID
   */
  async getComplianceReport(id: string): Promise<ComplianceReport> {
    const report = await this.reportRepository.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException(`Compliance report not found: ${id}`);
    }
    return report;
  }

  /**
   * Get all compliance reports
   */
  async getComplianceReports(options: {
    page?: number;
    limit?: number;
    complianceType?: ComplianceType;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    data: ComplianceReport[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, complianceType, startDate, endDate } = options;

    const qb = this.reportRepository.createQueryBuilder('report');

    if (complianceType) qb.andWhere('report.complianceType = :complianceType', { complianceType });
    if (startDate) qb.andWhere('report.reportPeriodStart >= :startDate', { startDate });
    if (endDate) qb.andWhere('report.reportPeriodEnd <= :endDate', { endDate });

    qb.orderBy('report.createdAt', 'DESC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Run compliance checks for a framework
   */
  async runComplianceChecks(framework: ComplianceType): Promise<ComplianceCheckResult[]> {
    const requirements = this.getRequirements(framework);
    const results: ComplianceCheckResult[] = [];

    for (const req of requirements) {
      const result = await this.checkRequirement(req);
      results.push(result);
    }

    return results;
  }

  /**
   * Get compliance requirements for a framework
   */
  getRequirements(framework: ComplianceType): ComplianceRequirement[] {
    switch (framework) {
      case 'gdpr':
        return GDPR_REQUIREMENTS;
      default:
        return GDPR_REQUIREMENTS; // Default to GDPR for now
    }
  }

  /**
   * Check a single requirement
   */
  private async checkRequirement(req: ComplianceRequirement): Promise<ComplianceCheckResult> {
    // In production, these would be actual checks
    // For now, return mock results based on requirement ID
    switch (req.id) {
      case 'gdpr-2': // Data Subject Rights
        const pendingRequests = await this.dataRequestRepository.count({
          where: { status: In(['pending', 'in_progress']) },
        });
        const overdue = await this.getOverdueRequests();
        if (overdue.length > 0) {
          return {
            requirement: req,
            status: 'non_compliant',
            details: `${overdue.length} overdue data requests`,
            remediation: 'Process overdue requests immediately',
          };
        }
        return {
          requirement: req,
          status: 'compliant',
          details: `Data request handling operational. ${pendingRequests} pending requests.`,
        };

      case 'gdpr-3': // Breach Notification
        const recentBreaches = await this.incidentRepository.count({
          where: {
            dataBreached: true,
            reportedToAuthorities: false,
            createdAt: MoreThan(new Date(Date.now() - 72 * 60 * 60 * 1000)), // Last 72 hours
          },
        });
        if (recentBreaches > 0) {
          return {
            requirement: req,
            status: 'non_compliant',
            details: `${recentBreaches} unreported data breach(es) within 72 hours`,
            remediation: 'Report breaches to supervisory authority immediately',
          };
        }
        return {
          requirement: req,
          status: 'compliant',
          details: 'No unreported breaches',
        };

      default:
        return {
          requirement: req,
          status: 'compliant',
          details: 'Requirement met',
        };
    }
  }

  /**
   * Calculate compliance score
   */
  private calculateComplianceScore(results: ComplianceCheckResult[]): number {
    if (results.length === 0) return 100;

    const scores: Record<string, number> = {
      compliant: 100,
      partial: 50,
      non_compliant: 0,
      not_applicable: 100,
    };

    const total = results.reduce((sum, r) => sum + (scores[r.status] ?? 0), 0);
    return Math.round(total / results.length);
  }

  /**
   * Generate recommendations based on compliance results
   */
  private generateRecommendations(
    results: ComplianceCheckResult[],
    stats: { overdueCount: number; avgResponseDays: number },
  ): string[] {
    const recommendations: string[] = [];

    // Based on compliance check results
    const nonCompliant = results.filter((r) => r.status === 'non_compliant');
    if (nonCompliant.length > 0) {
      recommendations.push(
        `Address ${nonCompliant.length} non-compliant requirement(s) immediately`,
      );
    }

    const partial = results.filter((r) => r.status === 'partial');
    if (partial.length > 0) {
      recommendations.push(
        `Review and improve ${partial.length} partially compliant area(s)`,
      );
    }

    // Based on data request stats
    if (stats.overdueCount > 0) {
      recommendations.push(
        `Process ${stats.overdueCount} overdue data request(s)`,
      );
    }

    if (stats.avgResponseDays > 20) {
      recommendations.push(
        'Improve data request response time (currently averaging ' +
          `${stats.avgResponseDays} days, target is under 20 days)`,
      );
    }

    return recommendations;
  }

  /**
   * Generate executive summary
   */
  private generateExecutiveSummary(
    framework: ComplianceType,
    score: number,
    violationCount: number,
  ): string {
    const frameworkName = framework.toUpperCase();
    const status = score >= 90 ? 'strong' : score >= 70 ? 'adequate' : 'needs improvement';

    let summary = `This report provides an assessment of ${frameworkName} compliance for the reporting period. `;
    summary += `Overall compliance score is ${score}%, indicating ${status} compliance posture. `;

    if (violationCount > 0) {
      summary += `${violationCount} area(s) of non-compliance have been identified and require immediate attention. `;
    } else {
      summary += 'No critical compliance violations were identified. ';
    }

    summary += 'Refer to detailed findings for specific requirements and recommendations.';

    return summary;
  }

  // ============================================================================
  // Data Inventory & Processing Records
  // ============================================================================

  /**
   * Get data inventory (records of processing activities)
   */
  getDataInventory(): DataInventory[] {
    // In production, this would come from configuration/database
    return [
      {
        category: 'User Account Data',
        dataTypes: ['name', 'email', 'phone', 'address'],
        sources: ['User registration', 'Profile updates'],
        purposes: ['Account management', 'Communication'],
        retentionPeriod: 'Account lifetime + 7 years',
        legalBasis: 'Contract performance',
        thirdPartySharing: false,
        crossBorderTransfer: false,
      },
      {
        category: 'Farm Operations Data',
        dataTypes: ['sensor readings', 'production data', 'inventory'],
        sources: ['IoT sensors', 'User input', 'System automation'],
        purposes: ['Farm management', 'Analytics', 'Reporting'],
        retentionPeriod: '7 years',
        legalBasis: 'Contract performance',
        thirdPartySharing: false,
        crossBorderTransfer: false,
      },
      {
        category: 'Usage Analytics',
        dataTypes: ['page views', 'feature usage', 'session data'],
        sources: ['Application telemetry'],
        purposes: ['Product improvement', 'Support'],
        retentionPeriod: '2 years',
        legalBasis: 'Legitimate interest',
        thirdPartySharing: true,
        crossBorderTransfer: false,
      },
      {
        category: 'Support Communications',
        dataTypes: ['messages', 'tickets', 'attachments'],
        sources: ['Support system', 'Email'],
        purposes: ['Customer support', 'Quality assurance'],
        retentionPeriod: '3 years after resolution',
        legalBasis: 'Contract performance',
        thirdPartySharing: false,
        crossBorderTransfer: false,
      },
    ];
  }

  // ============================================================================
  // Scheduled Tasks
  // ============================================================================

  /**
   * Check for overdue requests and send reminders
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async checkOverdueRequests(): Promise<void> {
    const overdue = await this.getOverdueRequests();

    for (const request of overdue) {
      this.logger.warn(
        `Overdue data request: ${request.requestNumber} (${request.requestType}) - Due: ${request.dueDate}`,
      );

      // In production, send notifications
      // await this.notificationService.sendOverdueRequestAlert(request);
    }

    if (overdue.length > 0) {
      this.logger.warn(`Total overdue requests: ${overdue.length}`);
    }
  }

  /**
   * Auto-generate monthly compliance reports
   */
  @Cron('0 0 1 * *') // First day of each month
  async generateMonthlyReports(): Promise<void> {
    this.logger.log('Generating monthly compliance reports...');

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(now.getFullYear(), now.getMonth(), 0);

    await this.generateComplianceReport({
      complianceType: 'gdpr',
      reportPeriodStart: startDate,
      reportPeriodEnd: endDate,
      generatedBy: 'system',
      generatedByName: 'System',
      isAutoGenerated: true,
    });

    this.logger.log('Monthly compliance reports generated');
  }

  /**
   * Expire old download URLs
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireDownloadUrls(): Promise<void> {
    const result = await this.dataRequestRepository
      .createQueryBuilder()
      .update(DataRequest)
      .set({ downloadUrl: undefined })
      .where('downloadExpiresAt < :now', { now: new Date() })
      .andWhere('downloadUrl IS NOT NULL')
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Expired ${result.affected} download URL(s)`);
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private async generateRequestNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.dataRequestRepository.count({
      where: {
        createdAt: MoreThan(new Date(`${year}-01-01`)),
      },
    });
    return `DSR-${year}-${String(count + 1).padStart(5, '0')}`;
  }

  private getStatusChangeDescription(
    oldStatus: DataRequestStatus | undefined,
    newStatus: DataRequestStatus | undefined,
  ): string {
    if (!newStatus) return 'Status unchanged';
    if (!oldStatus) return `Status set to ${newStatus}`;
    return `Status changed from ${oldStatus} to ${newStatus}`;
  }

  private formatPeriod(start: Date, end: Date): string {
    const format = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `${format(start)} - ${format(end)}`;
  }

  private async logComplianceActivity(
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Would integrate with ActivityLoggingService
    this.logger.log(`Compliance activity: ${action}`, metadata);
  }
}

// Helper for TypeORM Not operator
function Not(value: unknown): unknown {
  return { $not: value };
}
