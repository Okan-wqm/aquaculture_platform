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
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogModule } from '../audit/audit.module';

import { ActivityLogController } from './controllers/activity-log.controller';
import { AuditTrailController } from './controllers/audit-trail.controller';
import { ComplianceController } from './controllers/compliance.controller';
import { SecurityMonitoringController } from './controllers/security-monitoring.controller';
import {
  ActivityLog,
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  DataRequest,
  ComplianceReport,
  LoginAttempt,
  ApiUsageLog,
} from './entities/security.entity';
import { ActivityLoggingService } from './services/activity-logging.service';
import { AuditTrailService } from './services/audit-trail.service';
import { SecuritySignalProjectionHandler } from './handlers/security-signal-projection.handler';
import { ComplianceService } from './services/compliance.service';
import { SecurityMonitoringService } from './services/security-monitoring.service';

@Module({
  imports: [
    ScheduleModule,
    AuditLogModule,
    TypeOrmModule.forFeature([
      // Activity & Audit
      ActivityLog,
      LoginAttempt,
      ApiUsageLog,
      // Security
      SecurityEvent,
      SecurityIncident,
      ThreatIntelligence,
      // Compliance
      DataRequest,
      ComplianceReport,
      // Configuration
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
    // The sink for `events.security.events.>`. A PROVIDER, not a controller:
    // `EventHandlerRegistryModule` discovers @SubscribeTo over
    // DiscoveryService.getProviders(), and a class registered under
    // `controllers` is invisible to it — which is also why the previous
    // @EventPattern version bound to nothing at all.
    SecuritySignalProjectionHandler,
  ],
  exports: [
    ActivityLoggingService,
    AuditTrailService,
    ComplianceService,
    SecurityMonitoringService,
  ],
})
export class SecurityModule {
  readonly moduleName = 'SecurityModule';
}
