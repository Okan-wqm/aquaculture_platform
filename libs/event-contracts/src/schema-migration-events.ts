/**
 * Schema-migration event contracts — Phase 6 NATS event-bridge shape.
 * ============================================================================
 *
 * Each service's MigrationRunnerService OPTIONALLY emits these events
 * to NATS via NatsMigrationEventSink. observability-service subscribes
 * and dispatches RecordMigrationEventCommand per event (→ durable row
 * in observability.migration_events).
 *
 * The event set mirrors the MigrationSinkEvent type in backend-common
 * but is wrapped in the BaseEvent contract (eventId + timestamp +
 * tenantId + aggregateId + aggregateType) so it composes with the
 * rest of the platform's event bus.
 *
 * # tenantId semantics
 *
 * Platform-level migrations (source schema) → GLOBAL_TENANT_UUID.
 * Tenant fan-out events → the cleartext tenant schema name derived
 * from the tenant_<uuid16> clone the runner is applying to. The
 * observability consumer HMACs before persisting.
 *
 * # aggregateId + aggregateType
 *
 * aggregateId = migration class name (e.g. AddEmployeePreferredName1234567890)
 * aggregateType = 'SchemaMigration'
 *
 * This gives downstream event-sourcing tools a natural aggregate
 * filter: every event for a specific migration lands under the same
 * aggregateId, enabling per-migration replay / timeline.
 */
import type { BaseEvent } from './base-event';

export interface SchemaMigrationStartedEvent extends BaseEvent {
  eventType: 'SchemaMigrationStarted';
  /** Service emitting the event — matches serviceName in backend-common. */
  serviceName: string;
  /** TypeORM migration class name (PascalCase + timestamp suffix). */
  migrationName: string;
  /**
   * Source schema OR tenant_<uuid16> when the runner is in fan-out
   * mode. Cleartext — observability consumer HMACs before persist.
   */
  targetSchema: string;
  /** Deploy environment string. 'production' / 'staging' / 'development'. */
  environment: string;
}

export interface SchemaMigrationAppliedEvent extends BaseEvent {
  eventType: 'SchemaMigrationApplied';
  serviceName: string;
  migrationName: string;
  targetSchema: string;
  environment: string;
  /** Duration of the migration's executeMigration() call in milliseconds. */
  durationMs: number;
}

export interface SchemaMigrationFailedEvent extends BaseEvent {
  eventType: 'SchemaMigrationFailed';
  serviceName: string;
  migrationName: string;
  targetSchema: string;
  environment: string;
  durationMs: number;
  /**
   * Sanitized PG error shape. Raw error objects MUST NOT cross the
   * event boundary — the sink applies sanitizePgError before publish
   * (runner-side). errorTemplate never contains row values per the
   * sanitizer contract (see libs/backend-common/src/utils/
   * sanitize-pg-error.util.ts).
   */
  sqlState: string | null;
  errorTemplate: string;
  constraintName: string | null;
  relation: string | null;
}

export interface SchemaMigrationSkippedEvent extends BaseEvent {
  eventType: 'SchemaMigrationSkipped';
  serviceName: string;
  migrationName: string;
  targetSchema: string;
  environment: string;
  /** Why the migration was skipped — runner decides the taxonomy. */
  reason: string;
}

/** Union of all schema-migration events for typed dispatch. */
export type SchemaMigrationEvent =
  | SchemaMigrationStartedEvent
  | SchemaMigrationAppliedEvent
  | SchemaMigrationFailedEvent
  | SchemaMigrationSkippedEvent;

/**
 * NATS subject prefix for schema-migration events. Consumers subscribe
 * to `events.platform.schema-migration.>` to receive all four event types
 * (observability-service derives its subscribe subject from THIS constant
 * so publisher and consumer cannot drift).
 *
 * ORPHAN-MEDIUM-326 — WHY the `events.` prefix is part of the constant:
 * NatsEventBus.normalizeSubject REJECTS (throws on) any subject outside
 * the `events.`/`commands.`/`queries.` spaces, and the JetStream stream
 * only captures those. The previous value (`platform.schema-migration`)
 * made every sink publish die client-side — swallowed as best-effort —
 * while observability consumed a subject nothing could ever produce.
 */
export const SCHEMA_MIGRATION_SUBJECT_PREFIX = 'events.platform.schema-migration';
