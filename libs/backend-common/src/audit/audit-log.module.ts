import { Module, Global, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogEntity } from './audit-log.entity';
import { AuditLogService } from './audit-log.service';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AUDIT_LOG_SERVICE } from './audit-log.tokens';

/**
 * AuditLogModule
 *
 * Provides audit trail infrastructure for any microservice.
 * Registers the AuditLogEntity, AuditLogService, and AuditLogInterceptor.
 *
 * Usage:
 * ```ts
 * @Module({
 *   imports: [AuditLogModule],
 * })
 * export class AppModule {}
 * ```
 *
 * The module is @Global so AuditLogService and AuditLogInterceptor
 * are available throughout the application without re-importing.
 *
 * For services that have NATS EventBusModule imported, the interceptor
 * will automatically detect and use it for publishing audit events.
 * If EventBus is not available, it gracefully degrades to DB-only logging.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogEntity])],
  providers: [
    AuditLogService,
    AuditLogInterceptor,
    // SSoT for the cross-cutting audit dependency (TenantGuard et al inject
    // via AUDIT_LOG_SERVICE token + IAuditLogService interface). Provided
    // alongside the concrete class so existing concrete-class consumers
    // continue to work AND the token-based consumers resolve to the same
    // singleton.
    { provide: AUDIT_LOG_SERVICE, useExisting: AuditLogService },
  ],
  exports: [AuditLogService, AuditLogInterceptor, AUDIT_LOG_SERVICE],
})
export class AuditLogModule {
  /**
   * Import with default settings.
   * Uses TypeORM repository for DB storage and optionally
   * the EVENT_BUS token for NATS publishing.
   */
  static forRoot(): DynamicModule {
    return {
      module: AuditLogModule,
      global: true,
      imports: [TypeOrmModule.forFeature([AuditLogEntity])],
      providers: [
        AuditLogService,
        AuditLogInterceptor,
        { provide: AUDIT_LOG_SERVICE, useExisting: AuditLogService },
      ],
      exports: [AuditLogService, AuditLogInterceptor, AUDIT_LOG_SERVICE],
    };
  }
}
