import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * MigrationEvent — observability audit trail for the db-migrate pipeline.
 * ============================================================================
 *
 * Ships during Phase 0 of the db-migrate enterprise refactor (plan v3).
 * Every lifecycle boundary of every migration (start / applied / failed /
 * skipped) and every drift-validator emission (error / warn / clean) lands
 * here as a single durable record. Consumers:
 *
 *   - Grafana "Schema drift timeline" dashboard (Phase 9 Day-2 surface)
 *   - aqua-ctl CLI: `aqua-ctl drift recent --service hr --hours 24`
 *   - SOC2 CC4.1 change-management evidence (13-month retention per ADR-024)
 *
 * # tenant_id_hash — HMAC, not raw sha256
 *
 * Records that survive past a tenant's lifetime (audit trail does, by
 * definition) cannot contain a reversible identifier. v3 R3 + ADR-022:
 * pseudonymise via `hmacTenantHash(pepper, tenant_schema)` with the
 * per-environment pepper held in Vault. On TenantErased event,
 * observability-service deletes WHERE tenant_id_hash = hmac(pepper, schema)
 * — explicit cascade, no time-based purge.
 *
 * # drift_class_id — FK to drift-class registry
 *
 * Nullable because not every event is drift-related (migration apply
 * lifecycle has no associated class). When set, the value MUST be a
 * valid DriftClassId literal from libs/backend-common/src/database/
 * schema-drift/drift-classes.ts (enforced at CQRS command layer, not
 * DB — the registry is code, not a table).
 *
 * # error_detail — structured JSONB
 *
 * Plan v3 R32 shape:
 *   {
 *     class: 'MigrationFailed' | 'DriftDetected' | ...,
 *     code: '42P07' | 'SCHEMA_DRIFT' | ...,
 *     message: sanitized (libs/backend-common/src/utils/sanitize-pg-error.util),
 *     stack_hash: sha256 of normalized stack (no PII),
 *     pg_error_code?: SQLSTATE if applicable,
 *   }
 *
 * The sanitize step strips row data (`Key (ssn)=(123)`) before persist —
 * see `sanitizePgError()` + `assertNoPgRowLeak()`. CI invariant rejects
 * PII leakage in this column.
 *
 * # Indexes
 *
 * Primary query patterns:
 *   1. "last N events for service X in environment Y"
 *      → (service_name, environment, occurred_at DESC)
 *   2. "all events for a specific migration across services"
 *      → (migration_name, occurred_at DESC)
 *   3. "all drift events for a tenant" (tenant-cost-attribution queries)
 *      → (tenant_id_hash, drift_class_id, occurred_at DESC)
 *      [partial index — only rows with tenant_id_hash IS NOT NULL]
 */
@Entity('migration_events', { schema: 'observability' })
@Index('IDX_migration_events_service_env_time', [
  'serviceName',
  'environment',
  'occurredAt',
])
@Index('IDX_migration_events_migration_time', ['migrationName', 'occurredAt'])
export class MigrationEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt!: Date;

  /** Lowercase service slug — `hr`, `farm`, `billing`, `db-migrate`. */
  @Column({ type: 'varchar', length: 64, name: 'service_name' })
  serviceName!: string;

  /** TypeORM migration class name. Empty string for validator-only events. */
  @Column({ type: 'varchar', length: 256, name: 'migration_name' })
  migrationName!: string;

  @Column({
    type: 'enum',
    enum: ['start', 'applied', 'failed', 'skipped', 'validator_clean', 'validator_warn', 'validator_error'],
    enumName: 'migration_event_type_enum',
    name: 'event_type',
  })
  eventType!:
    | 'start'
    | 'applied'
    | 'failed'
    | 'skipped'
    | 'validator_clean'
    | 'validator_warn'
    | 'validator_error';

  /**
   * Nullable — only set for tenant-scoped events (per-tenant migration
   * fan-out, per-tenant drift scan). HMAC-pseudonymised per ADR-022 —
   * never a raw tenant id or schema name.
   */
  @Column({ type: 'varchar', length: 128, name: 'tenant_id_hash', nullable: true })
  tenantIdHash!: string | null;

  /**
   * DriftClassId literal from drift-classes.ts — nullable for
   * lifecycle events that are not drift-related.
   */
  @Column({ type: 'varchar', length: 64, name: 'drift_class_id', nullable: true })
  driftClassId!: string | null;

  /** Nullable — only set for applied / failed events. */
  @Column({ type: 'integer', name: 'duration_ms', nullable: true })
  durationMs!: number | null;

  /**
   * Structured error payload (R32). Null for success events. Passes
   * through sanitizePgError() + assertNoPgRowLeak() before persist.
   */
  @Column({ type: 'jsonb', name: 'error_detail', nullable: true })
  errorDetail!: Record<string, unknown> | null;

  /**
   * Deploy environment — `production`, `staging`, `local`. Read from
   * AQUA_ENV at emit time; indexed for per-env timeline slicing.
   */
  @Column({ type: 'varchar', length: 32 })
  environment!: string;
}
