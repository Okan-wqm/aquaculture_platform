/**
 * DebugToolsModule
 *
 * SECURITY (NEW-03): Debug tools are disabled by default in ALL environments.
 * Registration is controlled exclusively by the ENABLE_DEBUG_TOOLS environment variable.
 * This defense-in-depth approach ensures that even if NODE_ENV is misconfigured,
 * debug endpoints remain inaccessible unless explicitly opted-in.
 *
 * Usage:
 *   - Set ENABLE_DEBUG_TOOLS=true to register controllers, providers, and entities.
 *   - When disabled, the module registers as an empty shell (no controllers, no providers).
 *   - Always call DebugToolsModule.forRoot() — the bare class must NOT be imported directly.
 *
 * Contents (when enabled):
 *   - DebugToolsController: /debug endpoints
 *   - DebugSession, CapturedQuery, CapturedApiCall, CacheEntrySnapshot, FeatureFlagOverride entities
 *   - DebugToolsService (facade), DebugSessionService, QueryInspectorService,
 *     ApiCallInspectorService, CacheInspectorService, FeatureFlagDebugService
 */
import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  CacheEntrySnapshot,
  FeatureFlagOverride,
} from '../impersonation/entities';

import { DebugToolsController } from '../impersonation/controllers/debug-tools.controller';
import { DebugToolsService } from '../impersonation/services/debug-tools.service';
import { DebugSessionService } from '../impersonation/services/debug-session.service';
import { QueryInspectorService } from '../impersonation/services/query-inspector.service';
import { ApiCallInspectorService } from '../impersonation/services/api-call-inspector.service';
import { CacheInspectorService } from '../impersonation/services/cache-inspector.service';
import { FeatureFlagDebugService } from '../impersonation/services/feature-flag-debug.service';

@Module({})
export class DebugToolsModule {
  private static readonly logger = new Logger(DebugToolsModule.name);

  /**
   * Conditionally registers the debug tools module based on the ENABLE_DEBUG_TOOLS env var.
   *
   * SECURITY: Disabled by default in ALL environments for defense-in-depth.
   * Only registers controllers, providers, and entities when ENABLE_DEBUG_TOOLS=true.
   * When disabled, returns an empty module shell that exposes nothing.
   *
   * @returns DynamicModule — fully wired when enabled, empty shell when disabled.
   */
  static forRoot(): DynamicModule {
    const isEnabled = process.env['ENABLE_DEBUG_TOOLS'] === 'true';

    // INFRA-HIGH-142: production never honours the flag. Registering the
    // debug surface (raw tenant SQL, request/response bodies, Set-Cookie
    // headers at rest) on the production edge is a misconfiguration, and a
    // misconfiguration must fail the boot, not be silently obeyed or
    // silently ignored. The posture assertion in main.ts stops the process
    // first; this is the module's own line of defence when forRoot() is
    // composed elsewhere.
    if (isEnabled && process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'ENABLE_DEBUG_TOOLS=true is not permitted when NODE_ENV=production (INFRA-HIGH-142)',
      );
    }

    if (!isEnabled) {
      this.logger.log(
        'Debug tools DISABLED (ENABLE_DEBUG_TOOLS != "true"). No /debug endpoints registered.',
      );
      return { module: DebugToolsModule };
    }

    this.logger.warn(
      'Debug tools ENABLED (ENABLE_DEBUG_TOOLS=true). /debug endpoints are active — ' +
        'ensure this is intentional and access is audited.',
    );

    return {
      module: DebugToolsModule,
      imports: [
        ScheduleModule,
        TypeOrmModule.forFeature([
          DebugSession,
          CapturedQuery,
          CapturedApiCall,
          CacheEntrySnapshot,
          FeatureFlagOverride,
        ]),
      ],
      controllers: [DebugToolsController],
      providers: [
        // SRP-compliant individual services
        DebugSessionService,
        QueryInspectorService,
        ApiCallInspectorService,
        CacheInspectorService,
        FeatureFlagDebugService,
        // Facade for backward compatibility
        DebugToolsService,
      ],
      exports: [
        DebugToolsService,
        DebugSessionService,
        QueryInspectorService,
        ApiCallInspectorService,
        CacheInspectorService,
        FeatureFlagDebugService,
      ],
    };
  }
}
