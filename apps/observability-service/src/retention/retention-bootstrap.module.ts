import { Module, OnModuleInit } from '@nestjs/common';
import {
  RetentionEnforcementService,
  registerRetentionPolicy,
} from '@aquaculture/backend-common/database';

import { EmergencyOverrideEntity } from '../database/entities/emergency-override.entity';
import { MigrationBackfillProgressEntity } from '../database/entities/migration-backfill-progress.entity';
import { MigrationEventEntity } from '../database/entities/migration-event.entity';
import { SchemaObjectHistoryEntity } from '../database/entities/schema-object-history.entity';

/**
 * RetentionBootstrapModule — single module, many policies.
 * ============================================================================
 *
 * Replaces the retired MigrationEventsRetentionService (per-table
 * cron-wired service) with a one-call-per-table registration against
 * the RetentionPolicyRegistry from backend-common. The single
 * RetentionEnforcementService provider then iterates every registered
 * policy daily at 03:00 UTC.
 *
 * Why this shape:
 *
 *   1. "One service per table" was copy-paste — each new audit table
 *      meant a new service + module + spec file. This registry-
 *      driven pattern makes "add a retention policy" a one-liner.
 *
 *   2. Observability-service is the canonical home for retention
 *      policies because observability owns the DB tables whose
 *      retention windows SOC2 / KVKK audits against. Services that
 *      run their OWN audit tables can compose an equivalent module
 *      by importing RetentionEnforcementService + calling
 *      registerRetentionPolicy at their own module-init.
 *
 *   3. Registration happens in onModuleInit() — BEFORE the cron
 *      fires for the first time. NestJS module init ordering
 *      guarantees this sequence.
 *
 * Policies registered:
 *
 *   - migration_events      13 months (SOC2 CC4.1 12mo + 1mo buffer)
 *   - schema_object_history 7 years   (SOC2 CC8.1 change-management)
 *   - emergency_overrides   7 years   (SOC2 CC6.1 access control;
 *                                      legal-hold suppresses rows
 *                                      with revoked_at IS NULL AND
 *                                      expires_at > NOW()).
 *
 * Retention days for each is derived from ADR-024. Changing a window
 * is a one-line edit here — no new service, no new migration.
 */
@Module({
  providers: [RetentionEnforcementService],
  exports: [RetentionEnforcementService],
})
export class RetentionBootstrapModule implements OnModuleInit {
  onModuleInit(): void {
    registerRetentionPolicy({
      id: 'migration_events.13mo',
      ownerTag: 'soc2-cc4.1',
      entity: MigrationEventEntity,
      timestampProperty: 'occurredAt',
      retentionDays: 395, // 13 months (12mo SOC2 + 1mo buffer)
    });
    registerRetentionPolicy({
      id: 'schema_object_history.7y',
      ownerTag: 'soc2-cc8.1',
      entity: SchemaObjectHistoryEntity,
      timestampProperty: 'observedAt',
      retentionDays: 2556, // 7 years
    });
    registerRetentionPolicy({
      id: 'emergency_overrides.7y',
      ownerTag: 'soc2-cc6.1',
      entity: EmergencyOverrideEntity,
      timestampProperty: 'createdAt',
      retentionDays: 2556, // 7 years
      // Legal-hold semantics: retain indefinitely any row that is
      // STILL ACTIVE (not yet revoked AND not yet expired). Those
      // rows represent in-flight authorizations the audit trail
      // must preserve until natural closure.
      legalHoldClause: 'revoked_at IS NULL AND expires_at > NOW()',
    });
    registerRetentionPolicy({
      id: 'migration_backfill_progress.7y',
      ownerTag: 'soc2-cc8.1',
      entity: MigrationBackfillProgressEntity,
      timestampProperty: 'appliedAt',
      retentionDays: 2556, // 7 years
      // Contract-phase @ExpandContract migrations read this table
      // at runtime to resolve dependsOn (R6 gate). 7 years is long
      // enough that no practical release train deletes its own
      // dependency surface. Matches schema_object_history window.
    });
  }
}
