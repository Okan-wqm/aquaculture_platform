/**
 * Security Module
 *
 * Comprehensive security and audit module providing:
 * Immutable admin audit is owned exclusively by the global AuditLogModule.
 * - Compliance management (GDPR, data requests)
 * - Security monitoring with anomaly detection
 * - Threat intelligence management
 * - Incident response workflow
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ComplianceController } from './controllers/compliance.controller';
import { SecurityMonitoringController } from './controllers/security-monitoring.controller';
import {
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  DataRequest,
  ComplianceReport,
  LoginAttempt,
  ApiUsageLog,
  UserSession,
} from './entities/security.entity';
import { ComplianceService } from './services/compliance.service';
import { SecurityMonitoringService } from './services/security-monitoring.service';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([
      // Operational security projections; immutable audit is owned by AuditLogModule.
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
    ]),
  ],
  controllers: [ComplianceController, SecurityMonitoringController],
  providers: [ComplianceService, SecurityMonitoringService],
  exports: [ComplianceService, SecurityMonitoringService],
})
export class SecurityModule {
  readonly moduleName = 'SecurityModule';
}
