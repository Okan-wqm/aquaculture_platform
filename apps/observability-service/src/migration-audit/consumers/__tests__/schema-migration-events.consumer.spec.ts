import type { CommandBus } from '@platform/cqrs';
import type { NatsEventBus } from '@platform/event-bus';
import {
  type SchemaMigrationAppliedEvent,
  type SchemaMigrationFailedEvent,
  type SchemaMigrationSkippedEvent,
  type SchemaMigrationStartedEvent,
  createBaseEvent,
} from '@platform/event-contracts';

import { RecordMigrationEventCommand } from '../../commands/record-migration-event.command';
import { SchemaMigrationEventsConsumer } from '../schema-migration-events.consumer';

const GLOBAL_TENANT_UUID = '00000000-0000-0000-0000-000000000000';

function makeBus(): {
  commandBus: jest.Mocked<CommandBus>;
  natsBus: jest.Mocked<NatsEventBus>;
} {
  return {
    commandBus: {
      execute: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<CommandBus>,
    natsBus: {
      subscribeTo: jest.fn(async () => undefined),
      unsubscribeFrom: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<NatsEventBus>,
  };
}

describe('SchemaMigrationEventsConsumer', () => {
  it('subscribes on module init to the migration subject with durable group', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    expect(natsBus.subscribeTo).toHaveBeenCalledTimes(1);
    const call = natsBus.subscribeTo.mock.calls[0]!;
    expect(call[0]).toBe('events.platform.schema-migration.>');
    expect(call[2]).toMatchObject({
      durable: true,
      groupId: 'observability-schema-migration',
      startFrom: 'latest',
    });
  });

  it('SUBSCRIPTION failure is logged, not re-thrown (NATS may not be up)', async () => {
    const { commandBus, natsBus } = makeBus();
    (natsBus.subscribeTo as jest.Mock).mockRejectedValue(
      new Error('NATS connection refused'),
    );
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await expect(consumer.onModuleInit()).resolves.toBeUndefined();
  });

  it('translates SchemaMigrationStartedEvent → eventType=start', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationStartedEvent = {
      ...createBaseEvent('SchemaMigrationStarted', GLOBAL_TENANT_UUID, {
        aggregateId: 'M1',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationStarted',
      serviceName: 'hr',
      migrationName: 'M1',
      targetSchema: 'hr',
      environment: 'staging',
    };
    await handler(event);

    expect(commandBus.execute).toHaveBeenCalledTimes(1);
    const cmd = commandBus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd).toBeInstanceOf(RecordMigrationEventCommand);
    expect(cmd.payload).toMatchObject({
      serviceName: 'hr',
      migrationName: 'M1',
      eventType: 'start',
      environment: 'staging',
    });
    expect(cmd.payload).not.toHaveProperty('tenantSchema');
  });

  it('translates SchemaMigrationAppliedEvent → eventType=applied + durationMs', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationAppliedEvent = {
      ...createBaseEvent('SchemaMigrationApplied', GLOBAL_TENANT_UUID, {
        aggregateId: 'M2',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationApplied',
      serviceName: 'hr',
      migrationName: 'M2',
      targetSchema: 'hr',
      environment: 'production',
      durationMs: 987,
    };
    await handler(event);
    const cmd = commandBus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.eventType).toBe('applied');
    expect(cmd.payload.durationMs).toBe(987);
  });

  it('translates SchemaMigrationFailedEvent — errorDetail preserved (no double-sanitize)', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationFailedEvent = {
      ...createBaseEvent('SchemaMigrationFailed', GLOBAL_TENANT_UUID, {
        aggregateId: 'M3',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationFailed',
      serviceName: 'hr',
      migrationName: 'M3',
      targetSchema: 'hr',
      environment: 'production',
      durationMs: 123,
      sqlState: '23505',
      errorTemplate: 'unique violation',
      constraintName: 'pk_x',
      relation: 'hr.x',
    };
    await handler(event);
    const cmd = commandBus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.eventType).toBe('failed');
    expect(cmd.payload.durationMs).toBe(123);
    expect(cmd.payload.errorDetail).toEqual({
      sqlState: '23505',
      template: 'unique violation',
      constraintName: 'pk_x',
      relation: 'hr.x',
    });
    // The raw error field is not populated — downstream handler
    // persists errorDetail verbatim.
    expect(cmd.payload).not.toHaveProperty('error');
  });

  it('translates SchemaMigrationSkippedEvent → eventType=skipped', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationSkippedEvent = {
      ...createBaseEvent('SchemaMigrationSkipped', GLOBAL_TENANT_UUID, {
        aggregateId: 'M4',
        aggregateType: 'SchemaMigration',
      }),
      eventType: 'SchemaMigrationSkipped',
      serviceName: 'hr',
      migrationName: 'M4',
      targetSchema: 'hr',
      environment: 'staging',
      reason: 'already applied',
    };
    await handler(event);
    const cmd = commandBus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.eventType).toBe('skipped');
  });

  it('forwards tenantSchema for tenant fan-out events', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationAppliedEvent = {
      ...createBaseEvent(
        'SchemaMigrationApplied',
        'tenant_1234567890abcdef',
        {
          aggregateId: 'M',
          aggregateType: 'SchemaMigration',
        },
      ),
      eventType: 'SchemaMigrationApplied',
      serviceName: 'hr',
      migrationName: 'M',
      targetSchema: 'tenant_1234567890abcdef',
      environment: 'production',
      durationMs: 50,
    };
    await handler(event);
    const cmd = commandBus.execute.mock.calls[0]![0] as RecordMigrationEventCommand;
    expect(cmd.payload.tenantSchema).toBe('tenant_1234567890abcdef');
  });

  it('handler failures are reported as a retry outcome (the bus owns redelivery within its budget)', async () => {
    const { commandBus, natsBus } = makeBus();
    (commandBus.execute as jest.Mock).mockRejectedValue(
      new Error('handler threw'),
    );
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleInit();
    const handler = natsBus.subscribeTo.mock.calls[0]![1].handle;

    const event: SchemaMigrationStartedEvent = {
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
    await expect(handler(event)).resolves.toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('onModuleDestroy unsubscribes cleanly', async () => {
    const { commandBus, natsBus } = makeBus();
    const consumer = new SchemaMigrationEventsConsumer(natsBus, commandBus);
    await consumer.onModuleDestroy();
    expect(natsBus.unsubscribeFrom).toHaveBeenCalledWith(
      'events.platform.schema-migration.>',
    );
  });
});
