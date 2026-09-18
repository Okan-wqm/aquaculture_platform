/**
 * @module MonitoringModule
 * @description Cross-tenant messaging monitoring aggregates for the admin-panel
 * NATS bridge (ADMIN-HIGH-009). Exports MonitoringStatsService so
 * EventHandlersModule can serve `request.messaging.admin.getMonitoringStats`
 * and `request.messaging.admin.getTenantsOverview`.
 *
 * PresenceModule is imported for the shared REDIS_CLIENT provider (same
 * wiring as AiModule) — the stats are cached under two low-cardinality keys.
 * BypassRlsService resolves from the global RlsModule registration.
 */
import { Module } from '@nestjs/common';

import { PresenceModule } from '../presence/presence.module';
import { MonitoringStatsService } from './services/monitoring-stats.service';

@Module({
  imports: [PresenceModule],
  providers: [MonitoringStatsService],
  exports: [MonitoringStatsService],
})
export class MonitoringModule {}
