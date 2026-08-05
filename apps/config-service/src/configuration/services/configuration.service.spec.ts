import { DataSource, Repository } from 'typeorm';

import {
  ConfigEnvironment,
  Configuration,
  ConfigValueType,
} from '../entities/configuration.entity';
import {
  type ConfigurationCache,
  type ConfigurationEncryption,
  ConfigurationService,
} from './configuration.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function secretConfiguration(value: string): Configuration {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: TENANT_ID,
    service: 'farm-service',
    key: 'cdse_credentials',
    value,
    valueType: ConfigValueType.SECRET,
    environment: ConfigEnvironment.ALL,
    isSecret: true,
    isActive: true,
    suppressFallback: false,
    version: 4,
  } as Configuration;
}

function serviceWith(input: {
  configuration: Configuration;
  encryption: ConfigurationEncryption;
}): ConfigurationService {
  const redis: ConfigurationCache = {
    get: jest.fn().mockResolvedValue(JSON.stringify(input.configuration)),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    deletePattern: jest.fn().mockResolvedValue(1),
  };
  return new ConfigurationService(
    {} as Repository<Configuration>,
    {} as DataSource,
    input.encryption,
    redis,
  );
}

describe('ConfigurationService secret reads', () => {
  it('fails closed when the encryption service is unavailable', async () => {
    const service = serviceWith({
      configuration: secretConfiguration('ENC_V2:ciphertext'),
      encryption: {
        isAvailable: jest.fn().mockReturnValue(false),
        isEncrypted: jest.fn().mockReturnValue(true),
        decrypt: jest.fn(),
      },
    });

    await expect(
      service.getEffectiveWithMeta(TENANT_ID, 'farm-service', 'cdse_credentials'),
    ).rejects.toThrow('Secret configuration is unavailable');
  });

  it('rejects legacy plaintext marked as a secret instead of returning it', async () => {
    const decrypt = jest.fn();
    const service = serviceWith({
      configuration: secretConfiguration('plaintext-client-secret'),
      encryption: {
        isAvailable: jest.fn().mockReturnValue(true),
        isEncrypted: jest.fn().mockReturnValue(false),
        decrypt,
      },
    });

    await expect(
      service.getEffectiveWithMeta(TENANT_ID, 'farm-service', 'cdse_credentials'),
    ).rejects.toThrow('Secret configuration is unavailable');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('decrypts authenticated ciphertext with tenant and key AAD', async () => {
    const decrypt = jest.fn().mockReturnValue('{"clientId":"id","clientSecret":"secret"}');
    const service = serviceWith({
      configuration: secretConfiguration('ENC_V2:ciphertext'),
      encryption: {
        isAvailable: jest.fn().mockReturnValue(true),
        isEncrypted: jest.fn().mockReturnValue(true),
        decrypt,
      },
    });

    await expect(
      service.getEffectiveWithMeta(TENANT_ID, 'farm-service', 'cdse_credentials'),
    ).resolves.toEqual({
      value: '{"clientId":"id","clientSecret":"secret"}',
      isSecret: true,
      sourceTenantId: TENANT_ID,
      configVersion: 4,
    });
    expect(decrypt).toHaveBeenCalledWith('ENC_V2:ciphertext', TENANT_ID, 'cdse_credentials');
  });
});
