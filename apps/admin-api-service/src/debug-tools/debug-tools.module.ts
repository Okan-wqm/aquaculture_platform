/**
 * DebugToolsModule
 *
 * Fix: H15 -- DebugTools ayrı modüle çıkarıldı (ImpersonationModule'dan ayrıştırma).
 * Bu modül sadece development/staging ortamlarında yüklenir.
 * Production'da app.module.ts'deki conditional import ile devre dışı kalır.
 *
 * İçerik:
 * - DebugToolsController: /debug endpoint'leri
 * - DebugSession, CapturedQuery, CapturedApiCall, CacheEntrySnapshot, FeatureFlagOverride entity'leri
 * - DebugToolsService (facade), DebugSessionService, QueryInspectorService,
 *   ApiCallInspectorService, CacheInspectorService, FeatureFlagDebugService
 */
import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    ScheduleModule.forRoot(),
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
})
export class DebugToolsModule {}
