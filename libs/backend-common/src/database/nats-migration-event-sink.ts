/**
 * NatsMigrationEventSink — publisher adapter for the Phase 6 event-bridge.
 * ============================================================================
 *
 * Translates MigrationSinkEvent (backend-common lifecycle shape) into
 * one of the four SchemaMigrationEvent variants from
 * @platform/event-contracts + publishes via an IEventPublisher
 * (typically a NATS-backed bus). The observability-service consumer
 * subscribes to `events.platform.schema-migration.>` and dispatches
 * RecordMigrationEventCommand per event.
 *
 * # Why this sink lives in backend-common (not in each service)
 *
 * Every service that wires createMigrationRunnerService already has
 * access to IEventPublisher via @platform/event-bus. Centralising the
 * publisher adapter in backend-common gives every service a one-line
 * opt-in:
 *
 *   createMigrationRunnerService('hr', {
 *     eventSink: new NatsMigrationEventSink(eventPublisher, 'hr'),
 *   })
 *
 * The sink handles:
 *   - Error sanitization via sanitizePgError (raw error never crosses
 *     the wire; SchemaMigrationFailedEvent carries sqlState + template
 *     + constraintName + relation only).
 *   - BaseEvent factory invocation (tenantId = GLOBAL_TENANT_UUID for
 *     source-schema events, cleartext tenant_<uuid16> for fan-out).
 *   - Subject routing under SCHEMA_MIGRATION_SUBJECT_PREFIX.
 *   - Fire-and-forget semantics — publish failure is logged but never
 *     thrown (runner MUST NOT rollback on audit-pipeline hiccup).
 */
import {
  SCHEMA_MIGRATION_SUBJECT_PREFIX,
  createBaseEvent,
  type SchemaMigrationAppliedEvent,
  type SchemaMigrationEvent,
  type SchemaMigrationFailedEvent,
  type SchemaMigrationSkippedEvent,
  type SchemaMigrationStartedEvent,
} from '@platform/event-contracts';

import { GLOBAL_TENANT_UUID } from '../tenant/constants';
import { sanitizePgError } from '../utils/sanitize-pg-error.util';
import type {
  MigrationEventSink,
  MigrationSinkEvent,
} from './migration-event-sink';

/**
 * Minimal publisher surface — matches IEventPublisher from
 * @platform/event-bus but declared locally to keep backend-common
 * free of the full event-bus dependency. Services pass any object
 * that satisfies this shape (the real NATS bus does).
 */
export interface MigrationEventPublisher {
  publishTo<TEvent extends { eventType: string }>(
    subject: string,
    event: TEvent,
  ): Promise<void>;
}

export interface NatsMigrationEventSinkOptions {
  /** Deploy environment string — 'production' / 'staging' / 'development'. */
  readonly environment?: string;
  /** Logger called when publish fails. Defaults to console.error. */
  readonly onPublishError?: (err: unknown, ev: MigrationSinkEvent) => void;
}

export class NatsMigrationEventSink implements MigrationEventSink {
  private readonly environment: string;
  private readonly onPublishError: (
    err: unknown,
    ev: MigrationSinkEvent,
  ) => void;

  constructor(
    private readonly publisher: MigrationEventPublisher,
    options: NatsMigrationEventSinkOptions = {},
  ) {
    this.environment =
      options.environment ??
      process.env['AQUA_ENV'] ??
      process.env['NODE_ENV'] ??
      'development';
    this.onPublishError =
      options.onPublishError ??
      ((err, ev) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(
          `[NatsMigrationEventSink] publish failed for ` +
            `${ev.serviceName}/${ev.migrationName} [${ev.eventType}]: ${msg}`,
        );
      });
  }

  async emit(event: MigrationSinkEvent): Promise<void> {
    try {
      const wire = this.toWireEvent(event);
      const subject = this.subjectFor(event.eventType);
      await this.publisher.publishTo(subject, wire);
    } catch (err) {
      this.onPublishError(err, event);
    }
  }

  private toWireEvent(event: MigrationSinkEvent): SchemaMigrationEvent {
    // tenantId routing: tenant fan-out events use cleartext schema
    // name; source-schema events use the GLOBAL sentinel. Consumer
    // HMACs tenant_<uuid16> at persist time.
    const tenantId =
      event.tenantSchema !== undefined
        ? event.tenantSchema
        : GLOBAL_TENANT_UUID;
    const targetSchema = event.tenantSchema ?? event.serviceName;

    switch (event.eventType) {
      case 'start':
        return {
          ...createBaseEvent('SchemaMigrationStarted', tenantId, {
            aggregateId: event.migrationName,
            aggregateType: 'SchemaMigration',
          }),
          eventType: 'SchemaMigrationStarted',
          serviceName: event.serviceName,
          migrationName: event.migrationName,
          targetSchema,
          environment: this.environment,
        } satisfies SchemaMigrationStartedEvent;

      case 'applied':
        return {
          ...createBaseEvent('SchemaMigrationApplied', tenantId, {
            aggregateId: event.migrationName,
            aggregateType: 'SchemaMigration',
          }),
          eventType: 'SchemaMigrationApplied',
          serviceName: event.serviceName,
          migrationName: event.migrationName,
          targetSchema,
          environment: this.environment,
          durationMs: event.durationMs ?? 0,
        } satisfies SchemaMigrationAppliedEvent;

      case 'failed': {
        const sanitized = sanitizePgError(event.error);
        return {
          ...createBaseEvent('SchemaMigrationFailed', tenantId, {
            aggregateId: event.migrationName,
            aggregateType: 'SchemaMigration',
          }),
          eventType: 'SchemaMigrationFailed',
          serviceName: event.serviceName,
          migrationName: event.migrationName,
          targetSchema,
          environment: this.environment,
          durationMs: event.durationMs ?? 0,
          sqlState: sanitized.sqlState,
          errorTemplate: sanitized.template,
          constraintName: sanitized.constraintName,
          relation: sanitized.relation,
        } satisfies SchemaMigrationFailedEvent;
      }

      case 'skipped':
        return {
          ...createBaseEvent('SchemaMigrationSkipped', tenantId, {
            aggregateId: event.migrationName,
            aggregateType: 'SchemaMigration',
          }),
          eventType: 'SchemaMigrationSkipped',
          serviceName: event.serviceName,
          migrationName: event.migrationName,
          targetSchema,
          environment: this.environment,
          reason: 'runner skipped',
        } satisfies SchemaMigrationSkippedEvent;
    }
  }

  private subjectFor(eventType: MigrationSinkEvent['eventType']): string {
    switch (eventType) {
      case 'start':
        return `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.started`;
      case 'applied':
        return `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.applied`;
      case 'failed':
        return `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.failed`;
      case 'skipped':
        return `${SCHEMA_MIGRATION_SUBJECT_PREFIX}.skipped`;
    }
  }
}
