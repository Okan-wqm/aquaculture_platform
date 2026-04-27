import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * MigrationBackfillProgressEntity — observability's source of truth
 * for "has migration X been applied in environment Y?"
 * ============================================================================
 *
 * # Why this table exists (R6 runtime gate)
 *
 * `@ExpandContract({phase:'contract', dependsOn: 'AddFoo1234'})` declares
 * that the contract migration MUST NOT run until the named expand
 * migration is already applied. The DECORATOR alone is a compile-time
 * contract; the RUNTIME gate needs a durable truth to check. Options
 * rejected:
 *
 *   - typeorm_migrations table: per-service, per-schema; a cross-
 *     service contract migration can't authoritatively read another
 *     service's typeorm_migrations without cross-schema grants.
 *   - Filesystem presence of the migration source: irrelevant — a
 *     file on disk doesn't mean the DB has the DDL.
 *   - Scanning pg_catalog for the schema artefact the expand
 *     migration added: brittle (two migrations may leave the same
 *     artefact), and doesn't carry environment/timestamp attribution.
 *
 * This table records, ONCE per (migration_name, environment), the
 * fact that a migration has been successfully applied. The row is
 * WRITTEN by RecordMigrationEventHandler on every `applied` event
 * (part of the Phase 0 audit pipeline — no new write path). The
 * CONTRACT-PHASE migration's runtime gate reads it BEFORE executing
 * its up().
 *
 * # PK shape
 *
 * Composite (migration_name, environment). Same migration applied in
 * multiple environments (staging + production) gets one row per
 * environment. Re-applying the same migration in the same environment
 * (edge case: DB restore, manual re-run) produces an UPSERT
 * (ON CONFLICT DO NOTHING) at the handler boundary — keeps the
 * FIRST successful apply timestamp.
 *
 * # Retention
 *
 * Effectively permanent for SOC2 CC8.1 evidence. Registered into
 * RetentionPolicyRegistry with a 7-year window alongside
 * schema_object_history (ADR-024). 7 years is long enough that
 * Phase 6 contract migrations can always resolve their
 * dependsOn — the window exceeds any practical multi-release-train
 * cadence.
 */
@Entity('migration_backfill_progress', { schema: 'observability' })
@Index('IDX_migration_backfill_progress_service_env', [
  'serviceName',
  'environment',
  'appliedAt',
])
export class MigrationBackfillProgressEntity {
  @PrimaryColumn({ type: 'varchar', length: 256, name: 'migration_name' })
  migrationName!: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  environment!: string;

  @Column({ type: 'varchar', length: 64, name: 'service_name' })
  serviceName!: string;

  /** First successful apply — UPSERT keeps the original timestamp. */
  @Column({ type: 'timestamptz', name: 'applied_at' })
  appliedAt!: Date;
}
