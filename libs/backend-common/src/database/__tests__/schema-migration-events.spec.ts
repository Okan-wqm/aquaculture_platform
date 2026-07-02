/**
 * Contract spec for @platform/event-contracts schema-migration events.
 * Lives under backend-common because (a) backend-common consumes these
 * events via NatsMigrationEventSink and (b) event-contracts has no
 * standalone jest runner in this Nx workspace.
 */
import {
  createBaseEvent,
  SCHEMA_MIGRATION_SUBJECT_PREFIX,
  type SchemaMigrationAppliedEvent,
  type SchemaMigrationEvent,
  type SchemaMigrationFailedEvent,
  type SchemaMigrationSkippedEvent,
  type SchemaMigrationStartedEvent,
} from '@platform/event-contracts';

import { GLOBAL_TENANT_UUID } from '../../tenant/constants';

describe('SchemaMigrationEvent contract', () => {
  it('SchemaMigrationStartedEvent composes with createBaseEvent', () => {
    const ev: SchemaMigrationStartedEvent = {
      ...createBaseEvent('SchemaMigrationStarted', GLOBAL_TENANT_UUID, {
        aggregateId: 'HealHrNullabilityDrift1787000000000',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationStarted',
      serviceName: 'hr',
      migrationName: 'HealHrNullabilityDrift1787000000000',
      targetSchema: 'hr',
      environment: 'staging',
    };
    expect(ev.eventType).toBe('SchemaMigrationStarted');
    expect(ev.tenantId).toBe(GLOBAL_TENANT_UUID);
    expect(typeof ev.eventId).toBe('string');
    expect(ev.aggregateType).toBe('SchemaMigration');
  });

  it('SchemaMigrationAppliedEvent requires durationMs', () => {
    const ev: SchemaMigrationAppliedEvent = {
      ...createBaseEvent('SchemaMigrationApplied', GLOBAL_TENANT_UUID, {
        aggregateId: 'M1',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationApplied',
      serviceName: 'hr',
      migrationName: 'M1',
      targetSchema: 'hr',
      environment: 'production',
      durationMs: 1234,
    };
    expect(ev.durationMs).toBe(1234);
  });

  it('SchemaMigrationFailedEvent carries sanitizer output (no raw error object)', () => {
    const ev: SchemaMigrationFailedEvent = {
      ...createBaseEvent('SchemaMigrationFailed', GLOBAL_TENANT_UUID, {
        aggregateId: 'M2',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationFailed',
      serviceName: 'hr',
      migrationName: 'M2',
      targetSchema: 'hr',
      environment: 'production',
      durationMs: 500,
      sqlState: '23505',
      errorTemplate: 'unique constraint violation',
      constraintName: 'pk_employees',
      relation: 'hr.employees',
    };
    // No `error` field — the sanitized shape is what travels on the wire.
    expect(ev).not.toHaveProperty('error');
    expect(ev.sqlState).toBe('23505');
    expect(ev.errorTemplate).not.toContain('Key (');
  });

  it('SchemaMigrationSkippedEvent requires a reason', () => {
    const ev: SchemaMigrationSkippedEvent = {
      ...createBaseEvent('SchemaMigrationSkipped', GLOBAL_TENANT_UUID, {
        aggregateId: 'M3',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationSkipped',
      serviceName: 'hr',
      migrationName: 'M3',
      targetSchema: 'hr',
      environment: 'staging',
      reason: 'already applied (pending list was empty)',
    };
    expect(ev.reason).toContain('already');
  });

  it('union type narrows via eventType discriminant', () => {
    function handle(ev: SchemaMigrationEvent): string {
      switch (ev.eventType) {
        case 'SchemaMigrationStarted':
          return `start ${ev.migrationName}`;
        case 'SchemaMigrationApplied':
          return `applied in ${ev.durationMs}ms`;
        case 'SchemaMigrationFailed':
          return `failed sqlState=${ev.sqlState ?? 'null'}`;
        case 'SchemaMigrationSkipped':
          return `skipped: ${ev.reason}`;
      }
    }

    const started: SchemaMigrationStartedEvent = {
      ...createBaseEvent('SchemaMigrationStarted', GLOBAL_TENANT_UUID, {
        aggregateId: 'M',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationStarted',
      serviceName: 'hr',
      migrationName: 'M',
      targetSchema: 'hr',
      environment: 'staging',
    };
    expect(handle(started)).toBe('start M');
  });

  it('SCHEMA_MIGRATION_SUBJECT_PREFIX has the expected shape', () => {
    // ORPHAN-MEDIUM-322: the prefix MUST live in the canonical `events.`
    // space — normalizeSubject rejects anything else and the JetStream
    // stream only captures events./commands./queries.
    expect(SCHEMA_MIGRATION_SUBJECT_PREFIX).toBe('events.platform.schema-migration');
  });

  it('platform-level events use GLOBAL_TENANT_UUID; tenant fan-out uses cleartext schema', () => {
    const platformEvent: SchemaMigrationStartedEvent = {
      ...createBaseEvent('SchemaMigrationStarted', GLOBAL_TENANT_UUID, {
        aggregateId: 'M',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationStarted',
      serviceName: 'hr',
      migrationName: 'M',
      targetSchema: 'hr',
      environment: 'staging',
    };
    const tenantEvent: SchemaMigrationStartedEvent = {
      ...createBaseEvent('SchemaMigrationStarted', 'tenant_1234567890abcdef', {
        aggregateId: 'M',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationStarted',
      serviceName: 'hr',
      migrationName: 'M',
      targetSchema: 'tenant_1234567890abcdef',
      environment: 'staging',
    };
    expect(platformEvent.tenantId).toBe(GLOBAL_TENANT_UUID);
    expect(tenantEvent.tenantId).toMatch(/^tenant_/);
  });
});
