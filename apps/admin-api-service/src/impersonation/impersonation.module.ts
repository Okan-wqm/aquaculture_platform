import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities -- only impersonation-related
import { ImpersonationController } from './controllers';
import {
  ImpersonationSession,
  ImpersonationPermission,
} from './entities';

// Services -- only impersonation-related
import { ImpersonationService } from './services';

// Fix: H15 -- Debug tools (DebugToolsController, DebugSession, CapturedQuery,
// CapturedApiCall, CacheEntrySnapshot, FeatureFlagOverride, DebugToolsService
// ve alt servisleri) ayrı DebugToolsModule'a taşındı.
// ImpersonationModule artık sadece impersonation sorumluluğunu taşır (SRP).

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      ImpersonationSession,
      ImpersonationPermission,
    ]),
  ],
  controllers: [ImpersonationController],
  providers: [
    ImpersonationService,
  ],
  exports: [
    ImpersonationService,
  ],
})
export class ImpersonationModule {}
