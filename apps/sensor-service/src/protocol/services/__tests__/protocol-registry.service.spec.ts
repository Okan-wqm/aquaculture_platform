/**
 * SENSOR-MEDIUM-069: sensor_protocols is per-tenant cloned reference data. The
 * boot sync must reach the source schema AND every provisioned tenant schema, or
 * a protocol added in a later release never lands in an existing tenant's copy
 * and registerSensor cannot resolve it ("No protocol configured").
 */
jest.mock('@aquaculture/backend-common/database', () => ({
  forEachTenantSchema: jest.fn(),
}));

import { ModuleRef } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { forEachTenantSchema } from '@aquaculture/backend-common/database';

import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { ProtocolRegistryService } from '../protocol-registry.service';

interface FakeManager {
  connection: unknown;
  findOne: jest.Mock;
  update: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

const makeManager = (): FakeManager => ({
  connection: {},
  findOne: jest.fn().mockResolvedValue(null),
  update: jest.fn(),
  save: jest.fn(),
  create: jest.fn((_entity: unknown, data: unknown) => data),
});

describe('ProtocolRegistryService protocol sync (SENSOR-MEDIUM-069)', () => {
  let service: ProtocolRegistryService;
  let sourceManager: FakeManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    sourceManager = makeManager();

    // Every adapter class resolves to a distinct fake adapter keyed by class name.
    const moduleRef = {
      get: jest.fn().mockImplementation((cls: { name: string }) => ({
        protocolCode: cls.name,
        displayName: cls.name,
        category: 'IOT',
        subcategory: undefined,
        connectionType: 'TCP',
        description: cls.name,
        getConfigurationSchema: () => ({ type: 'object', properties: {} }),
        getDefaultConfiguration: () => ({}),
        getCapabilities: () => ({}),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProtocolRegistryService,
        { provide: getRepositoryToken(SensorProtocol), useValue: { manager: sourceManager } },
        { provide: ModuleRef, useValue: moduleRef },
      ],
    }).compile();

    service = module.get(ProtocolRegistryService);
  });

  it('syncs the source schema AND fans the catalog out to every tenant schema', async () => {
    const tenantManager = makeManager();
    jest.mocked(forEachTenantSchema).mockImplementation(async (_dataSource, handler) => {
      await handler({ schema: 'tenant_abcdef0123456789', queryRunner: { manager: tenantManager } } as never);
      return [{ schema: 'tenant_abcdef0123456789', outcome: 'ok' }];
    });

    await service.onModuleInit();

    // Source copy written (existing behaviour, preserved).
    expect(sourceManager.save).toHaveBeenCalled();
    // SENSOR-MEDIUM-069: the code-defined catalog reached the tenant schema too.
    expect(forEachTenantSchema).toHaveBeenCalledTimes(1);
    expect(tenantManager.save).toHaveBeenCalled();
    // Same set of protocols in both — no tenant left frozen at provision time.
    expect(tenantManager.save.mock.calls.length).toBeGreaterThan(0);
    expect(tenantManager.save.mock.calls.length).toBe(sourceManager.save.mock.calls.length);
  });

  it('updates an existing protocol row instead of inserting a duplicate', async () => {
    sourceManager.findOne.mockResolvedValue({ id: 'proto-1', code: 'existing' });
    jest.mocked(forEachTenantSchema).mockResolvedValue([]);

    await service.onModuleInit();

    expect(sourceManager.update).toHaveBeenCalled();
    expect(sourceManager.save).not.toHaveBeenCalled();
  });
});
