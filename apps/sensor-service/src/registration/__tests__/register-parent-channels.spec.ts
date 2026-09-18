import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { Sensor, SensorType } from '../../database/entities/sensor.entity';
import { ConnectionTesterService } from '../../protocol/services/connection-tester.service';
import { ProtocolRegistryService } from '../../protocol/services/protocol-registry.service';
import { ProtocolValidatorService } from '../../protocol/services/protocol-validator.service';
import { SensorTypeService } from '../../sensor-type/sensor-type.service';
import { ChannelManagementService } from '../services/channel-management.service';
import { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * SENSOR-HIGH-117: registerParentWithChildren must derive parent-side data
 * channels from the children (channelKey = sanitized dataPath) so the MQTT
 * listener — which resolves the topic to the PARENT and reads only that
 * sensor's sensor_data_channels — actually has channels to ingest through.
 * Before this fix a wizard-registered device wrote zero rows, silently.
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('registerParentWithChildren parent-channel derivation (SENSOR-HIGH-117)', () => {
  let service: SensorRegistrationService;
  let createChannels: jest.Mock;
  let savedEntities: Array<{ __entity: string; payload: Record<string, unknown> }>;

  const parentInput = {
    name: 'Water Quality Sonde',
    protocolCode: 'mqtt',
    protocolConfiguration: { topic: 'sensors/site-1/sonde' },
    serialNumber: 'WQ-001',
  };

  beforeEach(async () => {
    createChannels = jest.fn().mockResolvedValue([]);
    savedEntities = [];

    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        create: jest.fn((entity: unknown, payload: Record<string, unknown>) => ({
          __entity: String(entity),
          payload,
        })),
        save: jest.fn(
          (
            entity: unknown,
            obj: { payload?: Record<string, unknown> } & Record<string, unknown>,
          ) => {
            // manager.create() in this mock wraps the payload; a save may receive
            // either the wrapper or a plain object — flatten both.
            const flat = { ...(obj.payload ?? obj) } as Record<string, unknown> & {
              isParentDevice?: boolean;
            };
            savedEntities.push({ __entity: String(entity), payload: flat });
            return Promise.resolve({
              ...flat,
              id: flat.isParentDevice === true ? 'parent-1' : `child-${savedEntities.length}`,
            });
          },
        ),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorRegistrationService,
        {
          provide: getRepositoryToken(Sensor),
          useValue: {
            create: (o: unknown) => o,
            // Post-commit reload paths: the parent reload and the children
            // re-fetch (result shaping only — not under assertion here).
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'parent-1', tenantId: TENANT, name: 'Water Quality Sonde' }),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: DataSource,
          useValue: { createQueryRunner: () => queryRunner },
        },
        {
          provide: ProtocolRegistryService,
          useValue: {
            hasProtocol: () => true,
            getProtocolDetails: () => Promise.resolve({ id: 'proto-1' }),
          },
        },
        {
          provide: ProtocolValidatorService,
          useValue: { validate: () => ({ isValid: true, errors: [] }) },
        },
        { provide: ConnectionTesterService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ChannelManagementService,
          useValue: { createChannelsForSensor: createChannels },
        },
        { provide: SensorTypeService, useValue: { createChannelsFromTypeDefinition: jest.fn() } },
        { provide: OutboxPublisher, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();

    service = module.get(SensorRegistrationService);
  });

  it('creates one parent channel per child with sanitized channelKey and the raw dataPath', async () => {
    const result = await service.registerParentWithChildren(
      {
        parent: parentInput,
        children: [
          { name: 'Sıcaklık', type: SensorType.TEMPERATURE, dataPath: 'sensors.mid', unit: '°C' },
          { name: 'pH', type: SensorType.PH, dataPath: 'ph', unit: 'pH' },
        ],
        skipConnectionTest: true,
      },
      TENANT,
      USER,
    );

    expect(result.success).toBe(true);
    expect(createChannels).toHaveBeenCalledTimes(1);

    const [sensorId, tenantId, inputs] = createChannels.mock.calls[0];
    expect(sensorId).toBe('parent-1');
    expect(tenantId).toBe(TENANT);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      channelKey: 'sensors_mid',
      dataPath: 'sensors.mid',
      displayLabel: 'Sıcaklık',
      unit: '°C',
      calibrationMultiplier: 1.0,
    });
    expect(inputs[1]).toMatchObject({ channelKey: 'ph', dataPath: 'ph' });
  });

  it('suffixes distinct dataPaths that sanitize to the same channelKey', async () => {
    await service.registerParentWithChildren(
      {
        parent: parentInput,
        children: [
          { name: 'A', type: SensorType.TEMPERATURE, dataPath: 'water.temp' },
          { name: 'B', type: SensorType.PH, dataPath: 'water_temp' },
        ],
        skipConnectionTest: true,
      },
      TENANT,
      USER,
    );

    const inputs = createChannels.mock.calls[0][2];
    expect(inputs.map((i: { channelKey: string }) => i.channelKey).sort()).toEqual([
      'water_temp',
      'water_temp_2',
    ]);
  });

  it('carries calibration, bounds and thresholds from the child onto the parent channel', async () => {
    await service.registerParentWithChildren(
      {
        parent: parentInput,
        children: [
          {
            name: 'O₂',
            type: SensorType.DISSOLVED_OXYGEN,
            dataPath: 'do',
            unit: 'mg/L',
            minValue: 0,
            maxValue: 15,
            calibrationEnabled: true,
            calibrationMultiplier: 1.1,
            calibrationOffset: -0.2,
            alertThresholds: { warning: { low: 4, high: 11 }, critical: { low: 2, high: 14 } },
            displaySettings: { color: '#4abba2', decimalPlaces: 2 },
          },
        ],
        skipConnectionTest: true,
      },
      TENANT,
      USER,
    );

    const channel = createChannels.mock.calls[0][2][0];
    expect(channel).toMatchObject({
      minValue: 0,
      maxValue: 15,
      calibrationEnabled: true,
      calibrationMultiplier: 1.1,
      calibrationOffset: -0.2,
    });
    expect(channel.alertThresholds).toEqual({
      warning: { low: 4, high: 11 },
      critical: { low: 2, high: 14 },
    });
    expect(channel.displaySettings).toMatchObject({ color: '#4abba2', precision: 2 });
  });

  it('still succeeds (without parent channels) when no child carries a dataPath', async () => {
    const result = await service.registerParentWithChildren(
      {
        parent: parentInput,
        children: [{ name: 'No path', type: SensorType.TEMPERATURE, dataPath: '' }],
        skipConnectionTest: true,
      },
      TENANT,
      USER,
    );

    expect(result.success).toBe(true);
    expect(createChannels).not.toHaveBeenCalled();
  });

  it('rolls back the whole create when channel creation fails inside the transaction', async () => {
    createChannels.mockRejectedValue(new Error('duplicate channel key'));

    const result = await service.registerParentWithChildren(
      {
        parent: parentInput,
        children: [{ name: 'T', type: SensorType.TEMPERATURE, dataPath: 't' }],
        skipConnectionTest: true,
      },
      TENANT,
      USER,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Registration failed');
  });
});
