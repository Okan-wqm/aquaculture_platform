import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor, SensorType } from '../../database/entities/sensor.entity';
import { ConnectionTesterService } from '../../protocol/services/connection-tester.service';
import { ProtocolRegistryService } from '../../protocol/services/protocol-registry.service';
import { ProtocolValidatorService } from '../../protocol/services/protocol-validator.service';
import { SensorTypeService } from '../../sensor-type/sensor-type.service';
import { ChannelManagementService } from '../services/channel-management.service';
import { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * SENSOR-MEDIUM-071: registerSensor can attach a custom SensorTypeDefinition and
 * its defaultChannels are bootstrapped inside the registration transaction — the
 * capability the deleted createSensor back door owned (and swallowed on failure).
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('registerSensor typeDefinitionId bootstrap (SENSOR-MEDIUM-071)', () => {
  let service: SensorRegistrationService;
  let capturedTypeDefId: string | undefined;
  let bootstrap: jest.Mock;
  let manager: { save: jest.Mock };

  const baseInput = {
    name: 'Custom Probe',
    type: SensorType.MULTI_PARAMETER,
    protocolCode: 'mqtt',
    protocolConfiguration: { topic: 'sensors/x' },
    skipConnectionTest: true,
  };

  beforeEach(async () => {
    capturedTypeDefId = undefined;
    bootstrap = jest.fn().mockResolvedValue([]);
    manager = {
      save: jest.fn((_entity: unknown, obj: { typeDefinitionId?: string }) => {
        capturedTypeDefId = obj.typeDefinitionId;
        return Promise.resolve({ ...obj, id: 'sensor-1', tenantId: TENANT });
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorRegistrationService,
        {
          provide: getRepositoryToken(Sensor),
          useValue: { create: (o: unknown) => o, count: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: DataSource,
          useValue: { transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) => cb(manager)) },
        },
        {
          provide: ProtocolRegistryService,
          useValue: { hasProtocol: () => true, getProtocolDetails: () => Promise.resolve({ id: 'proto-1' }) },
        },
        { provide: ProtocolValidatorService, useValue: { validate: () => ({ isValid: true, errors: [] }) } },
        { provide: ConnectionTesterService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ChannelManagementService, useValue: { createChannelsForSensor: jest.fn() } },
        { provide: SensorTypeService, useValue: { createChannelsFromTypeDefinition: bootstrap } },
        { provide: OutboxPublisher, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();

    service = module.get(SensorRegistrationService);
  });

  it('persists typeDefinitionId and bootstraps its channels inside the transaction', async () => {
    const result = await service.registerSensor(
      { ...baseInput, typeDefinitionId: 'td-1' },
      TENANT,
      'user-1',
    );

    expect(result.success).toBe(true);
    // Persisted on the sensor row.
    expect(capturedTypeDefId).toBe('td-1');
    // Bootstrapped through the SAME transaction manager (atomic with the insert).
    expect(bootstrap).toHaveBeenCalledWith('sensor-1', TENANT, 'td-1', manager);
  });

  it('does NOT bootstrap when no typeDefinitionId is supplied', async () => {
    const result = await service.registerSensor(baseInput, TENANT, 'user-1');

    expect(result.success).toBe(true);
    expect(capturedTypeDefId).toBeUndefined();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('fails the whole registration (rolls back) when the typeDefinitionId does not resolve', async () => {
    bootstrap.mockRejectedValueOnce(
      new NotFoundException('Sensor type definition with ID "td-missing" not found'),
    );

    const result = await service.registerSensor(
      { ...baseInput, typeDefinitionId: 'td-missing' },
      TENANT,
      'user-1',
    );

    // No swallowed failure — the transaction threw, so registration reports failure.
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('createChannelsFromTypeDefinition manager threading (SENSOR-MEDIUM-071)', () => {
  it('uses the passed transaction manager repositories, not the injected auto-commit ones', async () => {
    const injectedType = { findOne: jest.fn(), save: jest.fn() };
    const injectedChannel = { find: jest.fn(), create: jest.fn(), save: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorTypeService,
        { provide: getRepositoryToken(SensorTypeDefinition), useValue: injectedType },
        { provide: getRepositoryToken(IndustryTemplate), useValue: {} },
        { provide: getRepositoryToken(SensorDataChannel), useValue: injectedChannel },
      ],
    }).compile();
    const service = module.get(SensorTypeService);

    const txnType = {
      findOne: jest.fn().mockResolvedValue({
        typeKey: 'trout',
        defaultChannels: [{ channelKey: 'ph', displayLabel: 'pH' }],
      }),
    };
    const txnChannel = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((o: unknown) => o),
      save: jest.fn((arr: unknown) => Promise.resolve(arr)),
    };
    // withRepository(repo) binds the INJECTED repo to the transaction and returns
    // the transaction-scoped repo the service then reads/writes through.
    const manager = {
      withRepository: jest.fn((repo: unknown) => (repo === injectedType ? txnType : txnChannel)),
    };

    const created = await service.createChannelsFromTypeDefinition(
      'sensor-1',
      TENANT,
      'td-1',
      manager as never,
    );

    // Bound both injected repos to the transaction…
    expect(manager.withRepository).toHaveBeenCalledWith(injectedType);
    expect(manager.withRepository).toHaveBeenCalledWith(injectedChannel);
    // …and wrote through the transaction-scoped repo.
    expect(txnChannel.save).toHaveBeenCalled();
    expect(created).toHaveLength(1);
    // The injected auto-commit repositories were never read/written directly.
    expect(injectedType.findOne).not.toHaveBeenCalled();
    expect(injectedChannel.save).not.toHaveBeenCalled();
  });
});
