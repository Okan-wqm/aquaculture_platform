import { Module, OnModuleInit } from '@nestjs/common';
import {
  RetentionEnforcementService,
  registerRetentionPolicy,
} from '@aquaculture/backend-common/database';

/**
 * Operational access-log retention only.
 *
 * Semantic audit evidence is deliberately absent from this runtime registry.
 * Its retention class must come from the signed data-protection authority and
 * may only be executed by the dedicated retention-controller database role;
 * an application cron with a build-time day count is not that authority.
 */
@Module({
  providers: [RetentionEnforcementService],
  exports: [RetentionEnforcementService],
})
export class AdminApiRetentionBootstrapModule implements OnModuleInit {
  onModuleInit(): void {
    // Access logs are operational telemetry rather than semantic audit
    // evidence, so this bounded runtime policy remains in this controller.
    registerRetentionPolicy({
      id: 'shared.access_logs.90d',
      ownerTag: 'access-log-observability',
      schema: 'shared',
      tableName: 'access_logs',
      timestampColumn: 'created_at',
      retentionDays: 90,
    });
  }
}
