import { Repository } from 'typeorm';
import { GLOBAL_TENANT_UUID } from '@aquaculture/backend-common/tenant';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import {
  GetConfigurationsByServiceQuery,
} from '../queries/get-configurations.query';
import { GetConfigurationsByServiceHandler } from './get-configurations.handler';

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

describe('GetConfigurationsByServiceHandler', () => {
  it('loads system-wide defaults by GLOBAL_TENANT_UUID and lets tenant values override them', async () => {
    const systemConfig = makeConfiguration({
      id: 'config-system',
      tenantId: GLOBAL_TENANT_UUID,
      value: '5',
    });
    const tenantConfig = makeConfiguration({
      id: 'config-tenant',
      tenantId: TENANT_ID,
      value: '10',
    });
    const repository = {
      find: jest.fn().mockResolvedValue([systemConfig, tenantConfig]),
    };
    const handler = new GetConfigurationsByServiceHandler(
      repository as unknown as Repository<Configuration>,
    );

    const result = await handler.execute(
      new GetConfigurationsByServiceQuery(TENANT_ID, 'sensor-service'),
    );

    expect(repository.find).toHaveBeenCalledWith({
      where: [
        {
          tenantId: TENANT_ID,
          service: 'sensor-service',
          isActive: true,
        },
        {
          tenantId: GLOBAL_TENANT_UUID,
          service: 'sensor-service',
          isActive: true,
        },
      ],
      order: { key: 'ASC' },
      take: 500,
    });
    expect(result).toEqual([tenantConfig]);
  });
});
