import { defined } from '@aquaculture/testing';

import {
  InMemoryMigrationEventSink,
  LoggerMigrationEventSink,
  NoopMigrationEventSink,
  type MigrationEventSink,
  type MigrationSinkEvent,
} from '../migration-event-sink';

function makeEvent(overrides: Partial<MigrationSinkEvent> = {}): MigrationSinkEvent {
  return {
    serviceName: 'hr',
    migrationName: 'HealHrNullabilityDrift1787000000000',
    eventType: 'applied',
    occurredAt: new Date('2026-04-21T11:00:00.000Z'),
    ...overrides,
  };
}

describe('NoopMigrationEventSink', () => {
  it('accepts events + returns void without throwing', () => {
    const sink: MigrationEventSink = new NoopMigrationEventSink();
    expect(() => sink.emit(makeEvent())).not.toThrow();
    expect(() =>
      sink.emit(makeEvent({ eventType: 'failed', error: new Error('x') })),
    ).not.toThrow();
  });
});

describe('InMemoryMigrationEventSink', () => {
  it('captures events in order', () => {
    const sink = new InMemoryMigrationEventSink();
    sink.emit(makeEvent({ eventType: 'start' }));
    sink.emit(makeEvent({ eventType: 'applied', durationMs: 42 }));
    expect(sink.events).toHaveLength(2);
    expect(defined(sink.events[0], 'Expected first migration event').eventType).toBe('start');
    const applied = defined(sink.events[1], 'Expected applied migration event');
    expect(applied.eventType).toBe('applied');
    expect(applied.durationMs).toBe(42);
  });

  it('clear() resets the buffer', () => {
    const sink = new InMemoryMigrationEventSink();
    sink.emit(makeEvent());
    sink.emit(makeEvent());
    sink.clear();
    expect(sink.events).toHaveLength(0);
  });
});

describe('LoggerMigrationEventSink', () => {
  it('calls the supplied logger with event data', () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const sink = new LoggerMigrationEventSink((msg, data) => {
      calls.push([msg, data]);
    });
    sink.emit(makeEvent({ eventType: 'applied', durationMs: 123 }));
    expect(calls).toHaveLength(1);
    const call = defined(calls[0], 'Expected logger call');
    expect(call[0]).toContain('hr applied HealHr');
    expect(call[1]).toMatchObject({
      serviceName: 'hr',
      eventType: 'applied',
      durationMs: 123,
    });
  });

  it('surfaces tenantSchema when present', () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const sink = new LoggerMigrationEventSink((_msg, data) => {
      calls.push(data);
    });
    sink.emit(
      makeEvent({
        tenantSchema: 'tenant_1234567890abcdef',
      }),
    );
    expect(calls[0]).toMatchObject({
      tenantSchema: 'tenant_1234567890abcdef',
    });
  });

  it('emits hadError flag but never serializes the raw error object', () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const sink = new LoggerMigrationEventSink((_msg, data) => {
      calls.push(data);
    });
    sink.emit(
      makeEvent({
        eventType: 'failed',
        error: new Error(
          'duplicate key violates unique constraint\nDETAIL: Key (ssn)=(123-45-6789) already exists.',
        ),
      }),
    );
    expect(calls[0]).toMatchObject({ hadError: true });
    const serialized = JSON.stringify(calls[0]);
    // Raw error message (including PII pattern) MUST NOT leak through
    // the logger sink — that's the CQRS-backed sink's job via
    // sanitizePgError. LoggerMigrationEventSink is dev/staging only.
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('duplicate key');
  });

  it('swallows logger-fn exceptions — MUST NOT propagate to the runner', () => {
    const sink = new LoggerMigrationEventSink(() => {
      throw new Error('logger backend down');
    });
    expect(() => sink.emit(makeEvent())).not.toThrow();
  });

  it('omits optional fields when not supplied', () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const sink = new LoggerMigrationEventSink((_msg, data) => {
      calls.push(data);
    });
    sink.emit(makeEvent());
    expect(calls[0]).not.toHaveProperty('tenantSchema');
    expect(calls[0]).not.toHaveProperty('durationMs');
    expect(calls[0]).not.toHaveProperty('hadError');
  });
});

describe('MigrationEventSink interface typing', () => {
  it('accepts all three implementations where a MigrationEventSink is required', () => {
    const sinks: MigrationEventSink[] = [
      new NoopMigrationEventSink(),
      new InMemoryMigrationEventSink(),
      new LoggerMigrationEventSink((): void => undefined),
    ];
    for (const s of sinks) {
      expect(typeof s.emit).toBe('function');
    }
  });
});
