import { Repository } from 'typeorm';
import { GLOBAL_TENANT_UUID } from '@aquaculture/backend-common/tenant';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import { EncryptionService } from './encryption.service';
import { ConfigurationService } from './configuration.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeConfiguration(
  overrides: Partial<Configuration> = {},
): Configuration {
  return {
    id: 'config-1',
    tenantId: TENANT_ID,
    service: 'sensor-service',
    key: 'sample_rate',
    value: '10',
    valueType: ConfigValueType.NUMBER,
    environment: ConfigEnvironment.ALL,
    description: undefined,
    isSecret: false,
    isActive: true,
    defaultValue: undefined,
    validationRules: undefined,
    category: undefined,
    tags: undefined,
    createdAt: new Date('2026-05-30T00:00:00.000Z'),
    updatedAt: new Date('2026-05-30T00:00:00.000Z'),
    createdBy: undefined,
    updatedBy: undefined,
    version: 1,
    getTypedValue: jest.fn(),
    ...overrides,
  };
}

function createService(repository: Partial<Repository<Configuration>>) {
  const encryptionService = {
    isAvailable: jest.fn(() => false),
    isEncrypted: jest.fn(() => false),
    decrypt: jest.fn(),
  } as unknown as EncryptionService;

  return new ConfigurationService(
    repository as Repository<Configuration>,
    encryptionService,
  );
}

describe('ConfigurationService system tenant fallback', () => {
  it('queries tenant config with GLOBAL_TENANT_UUID fallback', async () => {
    const tenantConfig = makeConfiguration({ tenantId: TENANT_ID });
    const systemConfig = makeConfiguration({
      id: 'config-system',
      tenantId: GLOBAL_TENANT_UUID,
      value: '5',
    });
    const repository = {
      find: jest.fn().mockResolvedValue([systemConfig, tenantConfig]),
    };
    const service = createService(repository);

    await expect(
      service.get(TENANT_ID, 'sensor-service', 'sample_rate'),
    ).resolves.toBe(10);

    expect(repository.find).toHaveBeenCalledWith({
      where: [
        {
          tenantId: TENANT_ID,
          service: 'sensor-service',
          key: 'sample_rate',
          isActive: true,
        },
        {
          tenantId: GLOBAL_TENANT_UUID,
          service: 'sensor-service',
          key: 'sample_rate',
          isActive: true,
        },
      ],
      take: 2,
    });
  });

  it('seeds defaults under GLOBAL_TENANT_UUID', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const orIgnore = jest.fn(() => ({ execute }));
    const values = jest.fn(() => ({ orIgnore }));
    const into = jest.fn(() => ({ values }));
    const insert = jest.fn(() => ({ into }));
    const repository = {
      createQueryBuilder: jest.fn(() => ({ insert })),
    };
    const service = createService(repository);

    await service.seedDefaults([
      {
        service: 'sensor-service',
        key: 'sample_rate',
        value: '10',
      },
    ]);

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        tenantId: GLOBAL_TENANT_UUID,
        service: 'sensor-service',
        key: 'sample_rate',
      }),
    ]);
  });
});
