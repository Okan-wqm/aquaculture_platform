import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_INTERCEPTOR } from '@nestjs/core';

// Entities
import { RetentionPolicy } from './entities/retention-policy.entity';
import { LegalHold } from './entities/legal-hold.entity';
import { ComplianceAuditLog } from './entities/compliance-audit-log.entity';

// External entities referenced by services
import { Message } from '../message/entities/message.entity';

// Services
import { RetentionPolicyService } from './services/retention-policy.service';
import { LegalHoldService } from './services/legal-hold.service';
import { LegalHoldGuard } from './services/legal-hold.guard';
import { ComplianceAuditService } from './services/compliance-audit.service';
import { DataExportService } from './services/data-export.service';
import { AttachmentObjectPurgeService } from './services/attachment-object-purge.service';

// Command handlers
import { SetRetentionPolicyHandler } from './commands/set-retention-policy.handler';
import { ToggleLegalHoldHandler } from './commands/toggle-legal-hold.handler';

// Query handlers
import { GetAuditLogHandler } from './queries/get-audit-log.handler';
import { GetRetentionPoliciesHandler } from './queries/get-retention-policies.handler';

// Resolver
import { ComplianceResolver } from './resolvers/compliance.resolver';

// Interceptor
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';

const CommandHandlers = [SetRetentionPolicyHandler, ToggleLegalHoldHandler];
const QueryHandlers = [GetAuditLogHandler, GetRetentionPoliciesHandler];

/**
 * @module ComplianceModule
 * @description Enterprise compliance module providing retention policies,
 * legal hold management, compliance audit logging, and data export.
 *
 * Registers the AuditLogInterceptor globally (APP_INTERCEPTOR) so all
 * messaging GraphQL mutations are automatically logged.
 *
 * @see ADR-012 Phase 3 (Compliance)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RetentionPolicy,
      LegalHold,
      ComplianceAuditLog,
      Message,
    ]),
    CqrsModule,
  ],
  providers: [
    // Services
    RetentionPolicyService,
    LegalHoldService,
    LegalHoldGuard,
    ComplianceAuditService,
    DataExportService,
    AttachmentObjectPurgeService,

    // CQRS handlers
    ...CommandHandlers,
    ...QueryHandlers,

    // Resolver
    ComplianceResolver,

    // Global interceptor — captures all messaging mutations
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
  exports: [
    LegalHoldService,
    LegalHoldGuard,
    ComplianceAuditService,
    RetentionPolicyService,
    DataExportService,
    AttachmentObjectPurgeService,
  ],
})
export class ComplianceModule {}
