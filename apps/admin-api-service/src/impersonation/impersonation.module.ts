import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

// Entities
import {
  ImpersonationSession,
  ImpersonationPermission,
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  CacheEntrySnapshot,
  FeatureFlagOverride,
} from './entities';

// Services
import { ImpersonationService, DebugToolsService } from './services';

// Controllers
import { ImpersonationController, DebugToolsController } from './controllers';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      // Impersonation
      ImpersonationSession,
      ImpersonationPermission,
      // Debug Tools
      DebugSession,
      CapturedQuery,
      CapturedApiCall,
      CacheEntrySnapshot,
      FeatureFlagOverride,
    ]),
  ],
  controllers: [ImpersonationController, DebugToolsController],
  providers: [ImpersonationService, DebugToolsService],
  exports: [ImpersonationService, DebugToolsService],
})
export class ImpersonationModule {}
