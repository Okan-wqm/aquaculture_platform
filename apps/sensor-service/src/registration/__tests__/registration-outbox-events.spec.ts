/**
 * SENSOR-LOW-007 — registration lifecycle events publish through the outbox.
 *
 * registerSensor must enqueue durable, contract-conformant events
 * (SensorRegistrationStarted, SensorRegistered, SensorRegistrationCompleted)
 * on the transactional outbox — not the old in-process EventEmitter2 that no
 * cross-service consumer could observe.
 */
import { SensorRegistrationService } from '../services/sensor-registration.service';
import { SensorRegistrationStatus } from '../../database/entities/sensor.entity';

describe('SensorRegistrationService — outbox registration events (SENSOR-LOW-007)', () => {
  let service: SensorRegistrationService;
  let outboxPublisher: { enqueue: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  const tenantId = 'tenant-1';

  beforeEach(() => {
    const savedSensor = {
      id: 'sensor-1',
      name: 'Probe A',
      type: 'temperature',
      tenantId,
      farmId: 'farm-1',
      pondId: undefined,
      manufacturer: 'Acme',
      model: 'X1',
      registrationStatus: SensorRegistrationStatus.DRAFT,
      connectionStatus: { isConnected: false },
    };

    const sensorRepository = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockReturnValue(savedSensor),
      save: jest.fn().mockResolvedValue(savedSensor),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // transaction(cb) invokes cb with a manager whose save returns the sensor.
    const manager = { save: jest.fn().mockResolvedValue(savedSensor) };
    const dataSource = {
      transaction: jest.fn().mockImplementation((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };

    const protocolRegistry = {
      hasProtocol: jest.fn().mockReturnValue(true),
      getProtocolDetails: jest.fn().mockResolvedValue({ id: 'proto-1', code: 'MODBUS_TCP' }),
    };
    const protocolValidator = { validate: jest.fn().mockReturnValue({ isValid: true, errors: [] }) };
    const connectionTester = {};
    eventEmitter = { emit: jest.fn() };
    const channelManagement = { createChannelsForSensor: jest.fn().mockResolvedValue([]) };
    const sensorTypeService = { createChannelsFromTypeDefinition: jest.fn().mockResolvedValue([]) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };

    service = new SensorRegistrationService(
      sensorRepository as never,
      dataSource as never,
      protocolRegistry as never,
      protocolValidator as never,
      connectionTester as never,
      eventEmitter as never,
      channelManagement as never,
      sensorTypeService as never,
      outboxPublisher as never,
    );
  });

  it('enqueues Started + Registered + Completed and does NOT use EventEmitter2 for registration', async () => {
    const result = await service.registerSensor(
      {
        name: 'Probe A',
        type: 'temperature',
        protocolCode: 'MODBUS_TCP',
        protocolConfiguration: { host: '8.8.8.8', port: 502 },
        skipConnectionTest: true,
      } as never,
      tenantId,
      'user-1',
    );

    expect(result.success).toBe(true);

    const eventTypes = outboxPublisher.enqueue.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'SensorRegistrationStarted',
        'SensorRegistered',
        'SensorRegistrationCompleted',
      ]),
    );

    // No registration lifecycle event went to the in-process emitter.
    const emitterEvents = eventEmitter.emit.mock.calls.map((c) => c[0] as string);
    expect(emitterEvents).not.toContain('sensor.registration.started');
    expect(emitterEvents).not.toContain('sensor.registration.completed');
  });

  it('builds flat, tenant-scoped contract events (createBaseEvent shape)', async () => {
    await service.registerSensor(
      {
        name: 'Probe A',
        type: 'temperature',
        protocolCode: 'MODBUS_TCP',
        protocolConfiguration: { host: '8.8.8.8', port: 502 },
        skipConnectionTest: true,
      } as never,
      tenantId,
      'user-1',
    );

    const registered = outboxPublisher.enqueue.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.eventType === 'SensorRegistered');

    expect(registered).toMatchObject({
      eventType: 'SensorRegistered',
      tenantId,
      sensorId: 'sensor-1',
      sensorType: 'temperature',
    });
    // createBaseEvent stamps an eventId + occurredAt on every event.
    expect(registered).toHaveProperty('eventId');
  });
});
