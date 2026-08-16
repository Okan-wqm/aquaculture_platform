import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogModule } from '../audit/audit.module';

// Entities -- only impersonation-related
import { ImpersonationController } from './controllers';
import {
  ImpersonationSession,
  ImpersonationPermission,
  ImpersonationAuthorizationReceipt,
  ImpersonationAuthorizationOperationReceipt,
} from './entities';

// Services -- only impersonation-related
import { ImpersonationService } from './services';

// Fix: H15 -- Debug tools (DebugToolsController, DebugSession, CapturedQuery,
// CapturedApiCall, FeatureFlagOverride, DebugToolsService
// ve alt servisleri) ayrı DebugToolsModule'a taşındı.
// ImpersonationModule artık sadece impersonation sorumluluğunu taşır (SRP).

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([
      ImpersonationSession,
      ImpersonationPermission,
      ImpersonationAuthorizationReceipt,
      ImpersonationAuthorizationOperationReceipt,
    ]),
    // H-S2-04: AuditLogModule enables USER_IMPERSONATED events in central audit log.
    AuditLogModule,
  ],
  controllers: [ImpersonationController],
  providers: [ImpersonationService],
  exports: [ImpersonationService],
})
export class ImpersonationModule {}
