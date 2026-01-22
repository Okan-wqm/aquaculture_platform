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
import { DebugSessionService } from './services/debug-session.service';
import { QueryInspectorService } from './services/query-inspector.service';
import { ApiCallInspectorService } from './services/api-call-inspector.service';
import { CacheInspectorService } from './services/cache-inspector.service';
import { FeatureFlagDebugService } from './services/feature-flag-debug.service';

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
  providers: [
    ImpersonationService,
    // Debug Tools services (SRP compliant)
    DebugSessionService,
    QueryInspectorService,
    ApiCallInspectorService,
    CacheInspectorService,
    FeatureFlagDebugService,
    // Facade for backward compatibility
    DebugToolsService,
  ],
  exports: [
    ImpersonationService,
    // Export both facade and individual services
    DebugToolsService,
    DebugSessionService,
    QueryInspectorService,
    ApiCallInspectorService,
    CacheInspectorService,
    FeatureFlagDebugService,
  ],
})
export class ImpersonationModule {}
