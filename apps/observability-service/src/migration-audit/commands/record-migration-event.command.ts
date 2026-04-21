/**
 * RecordMigrationEventCommand — CQRS entry point into migration_events.
 * ============================================================================
 *
 * Every db-migrate lifecycle moment + drift-validator emission dispatches
 * this command. The handler sanitizes error_detail (strips PG row leaks),
 * HMAC-pseudonymises tenantSchema into tenant_id_hash, and persists via
 * the repository.
 *
 * The command type is the single narrowing boundary between raw emitters
 * (orchestrator, validator, reconciler) and the durable audit store.
 */

export type MigrationEventType =
  | 'start'
  | 'applied'
  | 'failed'
  | 'skipped'
  | 'validator_clean'
  | 'validator_warn'
  | 'validator_error';

export interface RecordMigrationEventPayload {
  /** UTC ISO string recommended; defaults to now() in the handler when omitted. */
  readonly occurredAt?: Date;
  readonly serviceName: string;
  /** Empty string for validator-only events (no associated migration). */
  readonly migrationName: string;
  readonly eventType: MigrationEventType;
  /**
   * Cleartext tenant schema name (e.g. `tenant_abc1234...`). Handler
   * hashes via hmacTenantHash; never persisted as-is. Omit or pass
   * null for platform-level events.
   */
  readonly tenantSchema?: string | null;
  /** DriftClassId from drift-classes.ts when applicable; null otherwise. */
  readonly driftClassId?: string | null;
  readonly durationMs?: number | null;
  /**
   * Raw error object (usually a PG error or Error). Handler sanitizes
   * via sanitizePgError + assertNoPgRowLeak before persisting into the
   * error_detail JSONB column. Omit for success events.
   */
  readonly error?: unknown;
  /** Override environment; defaults to AQUA_ENV or 'development'. */
  readonly environment?: string;
}

export class RecordMigrationEventCommand {
  public readonly payload: RecordMigrationEventPayload;

  constructor(payload: RecordMigrationEventPayload) {
    this.payload = payload;
  }
}
