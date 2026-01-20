/**
 * Security Module
 *
 * Comprehensive security and audit module providing:
 * - Activity logging with buffered writes
 * - Audit trail with retention policies
 * - Compliance management (GDPR, data requests)
 * - Security monitoring with anomaly detection
 * - Threat intelligence management
 * - Incident response workflow
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import {
  ActivityLog,
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  DataRequest,
  ComplianceReport,
  RetentionPolicyEntity,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
} from './entities/security.entity';

// Services
import { ActivityLoggingService } from './services/activity-logging.service';
import { AuditTrailService } from './services/audit-trail.service';
import { ComplianceService } from './services/compliance.service';
import { SecurityMonitoringService } from './services/security-monitoring.service';

// Controllers
import { ActivityLogController } from './controllers/activity-log.controller';
import { AuditTrailController } from './controllers/audit-trail.controller';
import { ComplianceController } from './controllers/compliance.controller';
import { SecurityMonitoringController } from './controllers/security-monitoring.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      // Activity & Audit
      ActivityLog,
      LoginAttempt,
      ApiUsageLog,
      UserSession,
      // Security
      SecurityEvent,
      SecurityIncident,
      ThreatIntelligence,
      // Compliance
      DataRequest,
      ComplianceReport,
      // Configuration
      RetentionPolicyEntity,
    ]),
  ],
  controllers: [
    ActivityLogController,
    AuditTrailController,
    ComplianceController,
    SecurityMonitoringController,
  ],
  providers: [
    ActivityLoggingService,
    AuditTrailService,
    ComplianceService,
    SecurityMonitoringService,
  ],
  exports: [
    ActivityLoggingService,
    AuditTrailService,
    ComplianceService,
    SecurityMonitoringService,
  ],
})
export class SecurityModule {}
