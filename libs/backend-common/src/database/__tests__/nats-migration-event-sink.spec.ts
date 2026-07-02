import { GLOBAL_TENANT_UUID } from '../../tenant/constants';
import type { MigrationSinkEvent } from '../migration-event-sink';
import {
  NatsMigrationEventSink,
  type MigrationEventPublisher,
} from '../nats-migration-event-sink';

function makePublisher(
  behavior: 'resolve' | 'reject' = 'resolve',
): {
  publisher: jest.Mocked<MigrationEventPublisher>;
  calls: Array<{ subject: string; event: unknown }>;
} {
  const calls: Array<{ subject: string; event: unknown }> = [];
  const publisher = {
    publishTo: jest.fn((subject: string, event: unknown): Promise<void> => {
      calls.push({ subject, event });
      if (behavior === 'reject') {
        return Promise.reject(new Error('NATS publish failed'));
      }
      return Promise.resolve();
    }),
  } as unknown as jest.Mocked<MigrationEventPublisher>;
  return { publisher, calls };
}

function makeSinkEvent(
  overrides: Partial<MigrationSinkEvent> = {},
): MigrationSinkEvent {
  return {
    serviceName: 'hr',
    migrationName: 'HealHrNullabilityDrift1787000000000',
    eventType: 'applied',
    occurredAt: new Date('2026-04-21T12:00:00.000Z'),
    ...overrides,
  };
}

/** Narrow the first captured publish call without non-null assertions. */
function firstCall(calls: Array<{ subject: string; event: unknown }>): {
  subject: string;
  event: unknown;
} {
  const call = calls[0];
  if (!call) throw new Error('expected at least one publish call');
  return call;
}

describe('NatsMigrationEventSink', () => {
  it('publishes SchemaMigrationStartedEvent under the started subject', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher, { environment: 'staging' });
    await sink.emit(makeSinkEvent({ eventType: 'start' }));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('expected a publish call');
    expect(call.subject).toBe('events.platform.schema-migration.started');
    const ev = call.event as {
      eventType: string;
      serviceName: string;
      environment: string;
    };
    expect(ev.eventType).toBe('SchemaMigrationStarted');
    expect(ev.environment).toBe('staging');
    expect(ev.serviceName).toBe('hr');
  });

  it('publishes SchemaMigrationAppliedEvent carrying durationMs', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    await sink.emit(makeSinkEvent({ eventType: 'applied', durationMs: 321 }));
    expect(firstCall(calls).subject).toBe('events.platform.schema-migration.applied');
    const ev = firstCall(calls).event as { durationMs: number };
    expect(ev.durationMs).toBe(321);
  });

  it('publishes SchemaMigrationFailedEvent with SANITIZED error fields', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    const pgError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "pk_employees"\nDETAIL:  Key (ssn)=(123-45-6789) already exists.',
      ),
      { code: '23505', constraint: 'pk_employees', table: 'employees', schema: 'hr' },
    );
    await sink.emit(
      makeSinkEvent({ eventType: 'failed', durationMs: 50, error: pgError }),
    );
    expect(firstCall(calls).subject).toBe('events.platform.schema-migration.failed');
    const ev = firstCall(calls).event as {
      sqlState: string | null;
      errorTemplate: string;
      constraintName: string | null;
    };
    expect(ev.sqlState).toBe('23505');
    expect(ev.constraintName).toBe('pk_employees');
    // CRITICAL: raw SSN must NEVER travel on the wire.
    const serialized = JSON.stringify(firstCall(calls).event);
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toMatch(/Key \([^)]+\)=\([^)]+\)/);
  });

  it('routes tenant fan-out events with cleartext schema as tenantId', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    await sink.emit(
      makeSinkEvent({
        eventType: 'applied',
        durationMs: 100,
        tenantSchema: 'tenant_1234567890abcdef',
      }),
    );
    const ev = firstCall(calls).event as {
      tenantId: string;
      targetSchema: string;
    };
    expect(ev.tenantId).toBe('tenant_1234567890abcdef');
    expect(ev.targetSchema).toBe('tenant_1234567890abcdef');
  });

  it('routes platform-level events to GLOBAL_TENANT_UUID', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    await sink.emit(makeSinkEvent({ eventType: 'applied', durationMs: 100 }));
    const ev = firstCall(calls).event as { tenantId: string };
    expect(ev.tenantId).toBe(GLOBAL_TENANT_UUID);
  });

  it('SWALLOWS publisher errors (fire-and-forget contract)', async () => {
    const { publisher } = makePublisher('reject');
    const captured: unknown[] = [];
    const sink = new NatsMigrationEventSink(publisher, {
      onPublishError: (err) => {
        captured.push(err);
      },
    });
    await expect(sink.emit(makeSinkEvent())).resolves.toBeUndefined();
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toContain('NATS publish failed');
  });

  it('publishes SchemaMigrationSkippedEvent with default reason', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    await sink.emit(makeSinkEvent({ eventType: 'skipped' }));
    expect(firstCall(calls).subject).toBe('events.platform.schema-migration.skipped');
    const ev = firstCall(calls).event as { reason: string };
    expect(ev.reason).toContain('skipped');
  });

  it('honors explicit environment override', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher, {
      environment: 'production',
    });
    await sink.emit(makeSinkEvent({ eventType: 'start' }));
    const ev = firstCall(calls).event as { environment: string };
    expect(ev.environment).toBe('production');
  });

  it('generates a branded eventId per BaseEvent factory', async () => {
    const { publisher, calls } = makePublisher();
    const sink = new NatsMigrationEventSink(publisher);
    await sink.emit(makeSinkEvent({ eventType: 'start' }));
    const ev = firstCall(calls).event as {
      eventId: string;
      aggregateId: string;
      aggregateType: string;
    };
    expect(typeof ev.eventId).toBe('string');
    expect(ev.eventId.length).toBeGreaterThan(0);
    expect(ev.aggregateId).toBe('HealHrNullabilityDrift1787000000000');
    expect(ev.aggregateType).toBe('SchemaMigration');
  });
});
