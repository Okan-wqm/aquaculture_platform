import { AuditLogEntity } from '@aquaculture/backend-common/audit';
import {
  DESTRUCTIVE_EVENT_SINK,
  type DestructiveEventSink,
} from '@aquaculture/backend-common/guards';
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogController } from './audit.controller';
import { AuditLog } from './audit.entity';
import { AuditLogService } from './audit.service';

@Global()
@Module({
  // AuditLogEntity (shared.audit_logs) must be in the DataSource metadata so
  // the AuditedOperationInterceptor's repository lookup resolves (ADMIN-CRITICAL-008).
  imports: [TypeOrmModule.forFeature([AuditLog, AuditLogEntity])],
  controllers: [AuditLogController],
  providers: [
    AuditLogService,
    // ADR-0011: DestructiveActionGuard reports a stale or absent MFA claim on
    // an irreversible operation here. In detective mode this row is how the
    // operator sees which admin would have been refused; once enforcement
    // starts it records the refusal. Global so the guard resolves it from any
    // feature module's controller.
    {
      provide: DESTRUCTIVE_EVENT_SINK,
      useFactory: (auditLogService: AuditLogService): DestructiveEventSink => ({
        recordDestructiveWithoutFreshMfa: async (event) => {
          await auditLogService.record({
            action: event.enforced
              ? 'DESTRUCTIVE_REFUSED_WITHOUT_FRESH_MFA'
              : 'DESTRUCTIVE_WITHOUT_FRESH_MFA',
            entityType: 'PlatformAdminMfa',
            details: { route: event.route, reason: event.reason, enforced: event.enforced },
          });
        },
      }),
      inject: [AuditLogService],
    },
  ],
  exports: [AuditLogService, DESTRUCTIVE_EVENT_SINK],
})
export class AuditLogModule {}
