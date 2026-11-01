import { collaborator } from '@aquaculture/testing';
/**
 * SENSOR-LOW-007 — registration lifecycle events publish through the outbox.
 *
 * registerSensor must enqueue durable, contract-conformant events
 * (SensorRegistrationStarted, SensorRegistered, SensorRegistrationCompleted)
 * on the transactional outbox — not the old in-process EventEmitter2 that no
 * cross-service consumer could observe.
 */
import { SensorRegistrationService } from '../services/sensor-registration.service';
import { SensorPlacementService, UNPLACED } from '../services/sensor-placement.service';
import { SensorRegistrationStatus, SensorType } from '../../database/entities/sensor.entity';
import { RegisterSensorInput } from '../dto/register-sensor.dto';
import type { SensorMqttIdentityService } from '../../mqtt-identity/sensor-mqtt-identity.service';

describe('SensorRegistrationService — outbox registration events (SENSOR-LOW-007)', () => {
  let service: SensorRegistrationService;
  let outboxPublisher: { enqueue: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let issue: jest.Mock;
  let protocolRegistry: { hasProtocol: jest.Mock; getProtocolDetails: jest.Mock };
  const credentials = {
    sensorId: 'sensor-1',
    host: 'app.suderra.com',
    port: 8883,
    tls: true,
    clientId: `s${'a'.repeat(22)}`,
    username: `s${'a'.repeat(22)}`,
    password: 'p'.repeat(43),
    topic: 'tenants/tenant-1/sensors/sensor-1/data',
  };

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
      transaction: jest
        .fn()
        .mockImplementation((cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    };

    protocolRegistry = {
      hasProtocol: jest.fn().mockReturnValue(true),
      getProtocolDetails: jest.fn().mockResolvedValue({ id: 'proto-1', code: 'MODBUS_TCP' }),
    };
    const protocolValidator = {
      validate: jest.fn().mockReturnValue({ isValid: true, errors: [] }),
    };
    const connectionTester = {};
    eventEmitter = { emit: jest.fn() };
    const channelManagement = { createChannelsForSensor: jest.fn().mockResolvedValue([]) };
    const sensorTypeService = { createChannelsFromTypeDefinition: jest.fn().mockResolvedValue([]) };
    outboxPublisher = { enqueue: jest.fn().mockResolvedValue(undefined) };
    issue = jest.fn().mockResolvedValue(credentials);

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
      collaborator<SensorPlacementService>(
        { resolve: jest.fn().mockResolvedValue(UNPLACED) },
        'SensorPlacementService',
      ),
      collaborator<SensorMqttIdentityService>({ issue }, 'SensorMqttIdentityService'),
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

  it('issues an MQTT sensor its credential with the row, tests nothing, and leaves completion to its data (ADR-047 §5)', async () => {
    protocolRegistry.getProtocolDetails.mockResolvedValue({ id: 'proto-mqtt', code: 'MQTT' });

    const result = await service.registerSensor(
      Object.assign(new RegisterSensorInput(), {
        name: 'Probe A',
        type: SensorType.TEMPERATURE,
        protocolCode: 'MQTT',
        protocolConfiguration: {},
        skipConnectionTest: false,
      }),
      tenantId,
      'user-1',
    );

    expect(result).toMatchObject({
      success: true,
      connectionTestPassed: false,
      mqttCredentials: credentials,
    });
    expect(result.sensor?.registrationStatus).toBe(SensorRegistrationStatus.DRAFT);
    expect(issue).toHaveBeenCalledWith(expect.anything(), tenantId, 'sensor-1', 'user-1');
    const eventTypes = outboxPublisher.enqueue.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(eventTypes).toEqual(['SensorRegistrationStarted', 'SensorRegistered']);
  });
});
