import { SYSTEM_TENANT_ID } from '../configuration.constants';
import {
  Configuration,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';

import { toEffectiveConfigurationDto } from './effective-configuration.dto';

function configuration(overrides: Partial<Configuration> = {}): Configuration {
  const entity = Object.assign(new Configuration(), {
    id: 'config-id',
    tenantId: SYSTEM_TENANT_ID,
    service: 'auth-service',
    key: 'session_timeout',
    value: '30',
    valueType: ConfigValueType.NUMBER,
    environment: ConfigEnvironment.ALL,
    isSecret: false,
    isActive: true,
    version: 7,
    ...overrides,
  });
  return entity;
}

describe('toEffectiveConfigurationDto', () => {
  it('marks system fallback source without leaking storage tenant as requested tenant', () => {
    const dto = toEffectiveConfigurationDto(
      '123e4567-e89b-42d3-a456-426614174000',
      configuration(),
    );

    expect(dto.tenantId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(dto.source).toBe('system');
    expect(dto.sourceChain).toEqual([SYSTEM_TENANT_ID]);
    expect(dto.value).toBe(30);
    expect(dto.version).toBe(7);
    expect(dto.contentHash).toHaveLength(64);
  });

  it('redacts secret values in effective runtime responses', () => {
    const dto = toEffectiveConfigurationDto(
      '123e4567-e89b-42d3-a456-426614174000',
      configuration({
        tenantId: '123e4567-e89b-42d3-a456-426614174000',
        valueType: ConfigValueType.SECRET,
        value: 'ENC_V2:sensitive',
        isSecret: true,
      }),
    );

    expect(dto.source).toBe('tenant');
    expect(dto.value).toBe('[ENCRYPTED]');
    expect(dto.secretMode).toBe('redacted');
    expect(dto.cachePolicy).toEqual({ cacheable: false, ttlSeconds: 60 });
  });

  it('returns null for an empty secret so clients can tell "unset" from "redacted"', () => {
    // The seeded email.smtp_password row ships with an empty value; the
    // redaction sentinel would fabricate the existence of a stored secret.
    const dto = toEffectiveConfigurationDto(
      SYSTEM_TENANT_ID,
      configuration({
        valueType: ConfigValueType.SECRET,
        value: '',
        isSecret: true,
      }),
    );

    expect(dto.value).toBeNull();
    expect(dto.secretMode).toBe('redacted');
    expect(dto.cachePolicy).toEqual({ cacheable: false, ttlSeconds: 60 });
  });
});
