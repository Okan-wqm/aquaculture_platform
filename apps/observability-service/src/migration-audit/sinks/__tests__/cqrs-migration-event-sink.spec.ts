import type { CommandBus } from '@platform/cqrs';
import type { MigrationSinkEvent } from '@aquaculture/backend-common/database';

import { RecordMigrationEventCommand } from '../../commands/record-migration-event.command';
import { CqrsMigrationEventSink } from '../cqrs-migration-event-sink';

function makeBus(
  behavior: 'resolve' | 'reject' = 'resolve',
): jest.Mocked<CommandBus> {
  return {
    execute: jest.fn(async () => {
      if (behavior === 'reject') {
        throw new Error('downstream handler failed');
      }
    }),
  } as unknown as jest.Mocked<CommandBus>;
}

function makeEvent(
  overrides: Partial<MigrationSinkEvent> = {},
): MigrationSinkEvent {
  return {
    serviceName: 'hr',
    migrationName: 'HealHrNullabilityDrift1787000000000',
    eventType: 'applied',
    occurredAt: new Date('2026-04-21T11:30:00.000Z'),
    ...overrides,
  };
}

describe('CqrsMigrationEventSink', () => {
  it('dispatches a RecordMigrationEventCommand carrying every MigrationSinkEvent field', async () => {
    const bus = makeBus();
    const sink = new CqrsMigrationEventSink(bus);

    await sink.emit(
      makeEvent({
        eventType: 'applied',
        durationMs: 1234,
        tenantSchema: 'tenant_1234567890abcdef',
      }),
    );

    expect(bus.execute).toHaveBeenCalledTimes(1);
    const cmd = bus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd).toBeInstanceOf(RecordMigrationEventCommand);
    expect(cmd.payload).toMatchObject({
      serviceName: 'hr',
      migrationName: 'HealHrNullabilityDrift1787000000000',
      eventType: 'applied',
      durationMs: 1234,
      tenantSchema: 'tenant_1234567890abcdef',
    });
  });

  it('omits optional fields from the payload when not present', async () => {
    const bus = makeBus();
    const sink = new CqrsMigrationEventSink(bus);
    await sink.emit(makeEvent({ eventType: 'start' }));
    const cmd = bus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload).not.toHaveProperty('tenantSchema');
    expect(cmd.payload).not.toHaveProperty('durationMs');
    expect(cmd.payload).not.toHaveProperty('error');
  });

  it('passes raw error through to the handler for sanitization downstream', async () => {
    const bus = makeBus();
    const sink = new CqrsMigrationEventSink(bus);
    const pgError = Object.assign(
      new Error('duplicate key violates unique constraint'),
      { code: '23505' },
    );
    await sink.emit(
      makeEvent({ eventType: 'failed', error: pgError, durationMs: 50 }),
    );
    const cmd = bus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.error).toBe(pgError);
    expect(cmd.payload.eventType).toBe('failed');
    expect(cmd.payload.durationMs).toBe(50);
  });

  it('SWALLOWS commandBus errors (fire-and-forget contract)', async () => {
    const bus = makeBus('reject');
    const sink = new CqrsMigrationEventSink(bus);
    // Must resolve — never re-throw a bus failure.
    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
  });

  it('preserves occurredAt timestamp from the event', async () => {
    const bus = makeBus();
    const sink = new CqrsMigrationEventSink(bus);
    const when = new Date('2026-01-15T09:30:00.000Z');
    await sink.emit(makeEvent({ occurredAt: when }));
    const cmd = bus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.occurredAt).toBe(when);
  });
});
