import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit/audit.module';

// Entities -- only impersonation-related
import { ImpersonationController } from './controllers';
import { ImpersonationSession, ImpersonationPermission } from './entities';

// Services -- only impersonation-related
import { ImpersonationService } from './services';

// Fix: H15 -- Debug tools (DebugToolsController, DebugSession, CapturedQuery,
// CapturedApiCall, CacheEntrySnapshot, FeatureFlagOverride, DebugToolsService
// ve alt servisleri) ayrı DebugToolsModule'a taşındı.
// ImpersonationModule artık sadece impersonation sorumluluğunu taşır (SRP).

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([ImpersonationSession, ImpersonationPermission]),
    // H-S2-04: AuditLogModule enables USER_IMPERSONATED events in central audit log.
    AuditLogModule,
  ],
  controllers: [ImpersonationController],
  // PlatformAdminGuard is attached directly to ImpersonationController. Nest
  // resolves that guard in this module's context, so its non-global event
  // publisher must be available here as well as in the root module.
  providers: [ImpersonationService, SecurityEventService],
  exports: [ImpersonationService],
})
export class ImpersonationModule {}
