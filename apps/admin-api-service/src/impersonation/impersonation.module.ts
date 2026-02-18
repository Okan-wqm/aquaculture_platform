import { Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { ImpersonationController, DebugToolsController } from './controllers';
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
import { ApiCallInspectorService } from './services/api-call-inspector.service';
import { CacheInspectorService } from './services/cache-inspector.service';
import { DebugSessionService } from './services/debug-session.service';
import { FeatureFlagDebugService } from './services/feature-flag-debug.service';
import { QueryInspectorService } from './services/query-inspector.service';

// Controllers

const isProduction = process.env['NODE_ENV'] === 'production';

// In production, exclude DebugToolsController entirely (H-3: debug endpoints must not be available)
const controllers = isProduction
  ? [ImpersonationController]
  : [ImpersonationController, DebugToolsController];

if (isProduction) {
  new Logger('ImpersonationModule').log('Production mode: DebugToolsController disabled');
}

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
  controllers,
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
